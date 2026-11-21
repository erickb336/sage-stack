# Shared shell-write classification

`commandWrites(text, cwd, scratch, { readOnly, placed, home, guard, protect })` identifies known shell write forms and reader options
that can run another program. It parses text without executing it. Non-text or
unreadable input counts as a write form.

`scratch` is an optional list of absolute folders, such as the temp folder. A
redirection, or a gh clone or download (`ghTargets`), whose literal target is
in one of them, and not in `cwd` (the caller's project), does not count. Every other write form counts, also into a
scratch folder, except the placed write programs below. A target with a variable, a pattern or `~`, or in a folder that
the reader cannot follow, counts. Both providers pass the temp folders for a
read-only role (T933, T936). For the chief in sage mode (T948, T960, T807),
core's `chiefShellProblem` passes the chief's places (`chiefPlaces`: the temp
folders and the sage worktrees folder, which holds the pages roots), with
core's `CHIEF_SHELL` text.

`protect` (the read-only roles' rule, T1153) turns the scratch list around: a
target passes unless it is in, or holds, a protected folder. The protected
folders are the project's main checkout (found from `cwd`), each worktree of
its repository that is not in a scratch folder (read from
`.git/worktrees/*/gitdir`; a worktree in a scratch folder is an agent's own
copy), and the folders in `protect` (each hook passes its logbook roots).
`protect` implies `placed: true`. Each entry of `protect` is a named place,
`{ path, name, prefix }`. Core's `readOnlyPlace(roots, env, settings)` gives
both hooks the same options: the logbook roots and the sage worktrees folder
(`SAGE_WORKTREES`, default `~/sage-worktrees`), so a task worktree or a clone
there that git does not list is protected too. It also adds the home places
(`HOME_PLACES`, T1199): the agent config folders `~/.claude` and `~/.codex`,
Claude's user config file `~/.claude.json` with its backups beside it (a
prefix place: every name that starts with `.claude.json`, because it holds the
MCP servers, F-T1199-8), `~/.ssh`, and the shell start files (`~/.zshenv`, `~/.zprofile`, `~/.zshrc`,
`~/.zlogin`, `~/.zlogout`, `~/.bashrc`, `~/.bash_profile`, `~/.bash_login`,
`~/.bash_logout` and `~/.profile`). Core names no provider setting, so each
hook passes the config folders that its provider settings name, when they are
set, in `settings` (a place name for each folder, such as "the Claude config
folder"). A target that is a link to one of these places, or that
reaches one through `..`, is protected too, because each target counts
through its real path. In Codex, a write under any `.codex` folder meets the
earlier `.codex` rule first, with its own text. A scratch folder inside a
protected folder stays open (the nearer folder wins): the Claude hook gives the
investigate agent its pages folder as scratch, so its pages pass. A target
that the reader cannot tell (a pattern, a command substitution, or a `cd` into
a folder that it cannot follow) still counts, and so do the write forms with
no target that the reader knows (code in `node -e`, `tar`, `ln`, `curl` and
the others).

With `protect`, two more forms are read (T1153):

- **Literal names.** A variable set once, earlier in the same command, by a
  plain top-level assignment (`S=/tmp/x;` or `export S=/tmp/x &&`) to a value
  of path characters only, reads as that value in `$S` and `${S}`. A value
  with a variable, a substitution, a pattern, `~` or a space; a name that the
  command names again anywhere (a second assignment, `read S`, `${S:-x}`, the
  name in a path); an assignment in a subshell, a group, a pipe, after `&&` or
  `||`, or in the background; a use before the assignment or in single quotes;
  `$S:h` and `$S[1]` (zsh); and a command with a heredoc, `$'...'` or a
  substitution in double quotes keep the variable as one that the reader
  cannot tell. `HOME`, `CDPATH`, `PATH`, `IFS`, `PWD` and `OLDPWD` are never
  read, and a command that sets `HOME` or `CDPATH` counts as a write. A
  command that names `IFS` outside single quotes (`IFS=:`, `export IFS`) reads
  no variable at all, because a changed `IFS` splits a value into other words
  (`IFS=:; S=/tmp/x:src; rm -rf $S` removes `src`, F-T1153-10).
- **sed -i.** `sed -i`, `-i ''`, `-i.bak`, `-I` and `--in-place` count only
  for their file operands: every operand after the script, or every operand
  with `-e` or `-f`. Each one must pass as a target. For `sed`, an empty or
  suffix word (`.bak`) after a separate `-i` is BSD sed's suffix, and a word
  that is not empty must pass as a target too, because GNU sed reads it as a
  file (`sed -e s/a/b/ -i .env`, F-T1153-9). `gsed` is GNU sed: a separate
  `-i` takes no suffix. An option that the
  reader does not know, or a wrapper before sed (`xargs sed -i`), counts.
  `perl -i` and `ruby -i` still count. A limit: the reader does not read the
  sed script, so a `w` command in it writes where it names. Each
hook keeps the old temp-only rule for the lead, and when it cannot read the
logbook roots.

Inline code (`runsCode`, also `inlineCode` for the proof check) counts when a
word of a command names an interpreter and a later word is a code option
(`-c`, `-e`, `-p`, `--eval`). Every word counts, because a launcher puts the
interpreter after its own name (`uv run python -c`, `bundle exec ruby -e`,
`arch -arm64 node -e`, F-T1153-8). An option before the interpreter word does
not count, so the folder name in `mkdir -p /tmp/x/sh` is no shell.

`commandWritePart` takes the same arguments and gives `{ part, place }`, or
nothing when the text does not write. `part` is the part that writes: a simple
command, a redirection (`> src/a.js`) or a program run, or the whole text when
the reader cannot tell. `place` is the name of the protected place that the
part's target hit (for example `~/.ssh`, "the project's checkout" or "the
Claude config folder"), or nothing when the target is not known.
`commandWrites` is true when it gives a part. Core's `readOnlyShell(role,
write)` is the one refusal text for a read-only role's shell write: it quotes
the part, names the place that it hit (F-T1199-7), and lists the protected
places. Both hooks give it (F-T1153-13, F-T1153-15).

`placed: true` (the chief's rule, T807) lets the placed write programs `rm`,
`rmdir`, `touch`, `tee`, `cp` and `mv` count like a redirection: only when one
of their targets is outside the scratch folders. The targets are every
operand, and for `cp` only the last one, its destination. No operand, a `-t`
or `--target-directory` option, or a wrapper before the program (`xargs rm`,
`env rm`) counts as a write. `home` reads a leading `~` in a target as the
home folder. A target that holds the project, such as a parent folder of
`cwd`, counts too. Each target counts both as written (its folder's real path
and its own name, so `rm` of a link in the project counts) and through a link.

`guard` (the chief's rule, F-T807-1) lists folders, the sage worktrees folder,
where a git work tree holds repository files: a target in or over one is no
scratch place. A `.git` entry at the target, in a folder above it inside the
guard folder, or in a folder below it counts. The walk below reads at most
2,000 folders and does not follow links; a larger tree counts as one that holds
a work tree.

A write program's name (`rm`, `tee`, `install`, `sed -i`, `uniq`) counts only
where the command runs that program, also through a wrapper that the reader
knows (`xargs rm`, `env rm`, `find -exec rm`). As an argument it is data, so
`npm install`, `man tee` and a state-tool note with `--why rm` write nothing
(F-T960-3). awk code counts when it prints into a file or a command, or runs
`system()` or a command into `getline` (F-T932-4); a print into `/dev/stdout`,
`/dev/stderr` or `/dev/null`, and a `>` in parentheses (`print ($1 > 3)`), do
not (F-T936-1). `chmod`, `chown`, `chgrp`
and `chflags` count only for a path in `cwd` (F-T933-1), so `chmod +x` of a
fake in scratch, or `chmod -R u+w ~`, does not.

`readOnly: true` is for a role that changes no files (T936). It adds the git
commands that change the checkout (`gitTargets`): `checkout`, `switch`,
`restore`, `reset`, `clean`, `apply`, `am`, `merge`, `pull`, `rebase`,
`cherry-pick`, `revert`, `commit` and `add` at their work tree (the `-C` folder
or the command's folder), except a dry run, `git apply --check` and `--stat`;
`branch` with a delete, move, copy, force or upstream option and `config` with a
change at the work tree (`--global` or `--system` in every folder); and
`worktree add`, `move` and `remove` at their paths. The git forms that make
files also count at their targets (F-T1199-3, F-T1199-9): `clone` at its
directory (the last operand, or the repository's name in the work tree when
there is none) and its `--separate-git-dir`, `init` at its directory (or the
work tree), `archive` at `-o` or `--output`, `bundle create` at its file, and
`format-patch` at `-o`, `--output-directory` or `--output` (the work tree
without them, unless `--stdout`). In a scratch folder, outside
`cwd`, they do not count, so `git worktree add --detach /tmp/r/head <sha>` and
git inside that worktree run. `--git-dir` and `--work-tree` count in every
folder. The chief's rule leaves `readOnly` out, so the chief's git runs (T960).

A scratch folder's target counts only outside the project: the main checkout of
the repository that holds `cwd` (the nearest `.git` entry; a linked worktree's
`.git` file names its main checkout). So a worktree in the temp folder is
scratch also when it is `cwd` (F-T936-5).

`gitDestroysWork(text, cwd, scratch, guard)` is the chief's git rule (T968): true for
a git form that throws away uncommitted work at a work tree outside the scratch
folders: `reset --hard`, `checkout` with paths (after `--`, or `.`) or
`--force`, `switch --force` or `--discard-changes`, `clean` with `-f` (not a
dry run), `restore` of the work tree (not `--staged` alone) and `worktree
remove --force` at the path that it removes. A work tree in a `guard` folder is
no scratch folder. A line that the reader cannot read is false here;
`commandWrites` counts it. Core's `chiefShellProblem` (in `agent-rules.mjs`)
calls both, and both providers call it for the chief in sage mode, with core's
`CHIEF_GIT`, `CHIEF_SHELL` or `CHIEF_WORKTREE` text.

Executable-name checks ignore case and a trailing `.exe`, using the shared
normalizer. Reader-option parsing keeps the original arguments and option case.

The public core entry point exposes the same function in both provider bundles.
The Codex gate and the Claude hook both call it for a read-only role, with
core's `roleEditDenied`, the temp folders and `readOnly: true`.

The words of `gh` are its own arguments, so a word such as `PATCH` or `less` after `gh` does not count (`gh api -X PATCH`, T948); a redirection still counts.
`ghTargets` (in `output-writes.mjs`) reads the gh commands that write files
(F-T948-1, F-T948-5, F-T960-2), with gh's options before, between or after its
command words (`gh -R o/r release download`): `gh repo clone` and
`gh gist clone` (the folder that they name, or one named after the repository),
`gh repo fork --clone` and `gh repo create --clone` (a folder named after the
repository), `gh run download` and `gh release download` (the folder of `-D`,
the file of `-O`, or the command's folder), `gh attestation download` (the
command's folder) and `gh codespace cp` (a local destination). `gh extension install`,
`upgrade`, `remove` and `create` count in every folder. `gh pr checkout` does
not count: it changes the work tree as `git checkout` does.
The words of `git` are its own arguments too: of the write names, only
`git rm` and `git mv` count, so `git worktree add ../install` does not (T960);
the other git forms count only with `readOnly`. Ordinary reader arguments remain data. Option values and words after `--`
retain their parser context. Redirections to files count as
writes; input-only redirections and the listed standard device outputs do not.

`uniq` counts as a write only with an output operand (`uniq in out`), or
when the hook cannot count its operands: uniq is not the command word, or an
operand can expand to more words. `uniq in` and `uniq -c in` only read.

Known output-file programs also count as writes. These include curl output and
configuration options, Git diff/show/log output, OpenSSL output, and the ordinary
operands of ditto, scp, wget, and sqlite3. The curl scanner preserves option
case and skips known option values. Unknown curl and OpenSSL options count as writes.
The path check can permit an explicit scratch target while refusing a logbook
target. This does not inspect configuration files or prove sandbox protection.

Option references: [curl](https://curl.se/docs/manpage.html),
[Git diff](https://git-scm.com/docs/git-diff), and
[OpenSSL dgst](https://docs.openssl.org/master/man1/openssl-dgst/).

`readerDispatch(entry)` and `uniqWrites(words, base)` are the two classifiers
that `logbookWrite` (in `command-runs.mjs`) reuses: a reader with an option that
runs a program or writes a file, and `uniq` with an output operand.

A false result is not permission to execute a command. This classifier does not
prove that an arbitrary program cannot write. Callers must also enforce role,
command, path, and workflow rules using verified execution context.
