# Installed arena reader: final local probe

This probe checks the installed reader with fictional shared-logbook records.
It adds an explicitly invoked acceptance probe. The installed package is a required input.

Set `SAGE_INSTALLED_PLUGIN` to the absolute plugin folder before you run:

```sh
node --test scripts/probes/board-arena-installed.mjs
```

The folder must contain `core/board-reader.mjs`, `core/board-model.mjs`,
`board/reader.mjs`, and `board/markdown.mjs`. Missing input fails explicitly.
The probe neither skips nor falls back to repository source.
Run it with isolated home folders, a scratch temporary folder, telemetry disabled,
and safe process/network fakes, as the project standing orders require.

The probe reuses `scripts/fixtures/board-arena.mjs` and the reader test pattern.
It checks complete, failed, blocked, artifact-free, mismatched-run, and
incomplete-score cases. It checks the exact candidate, run, prototype URL,
score total, and selection. Report URLs retain each run identity and show
“Not kept” when the fictional logbook has no report.
Failed and blocked runs also retain their saved prototypes without a score or selection.
Every reader call checks that the fictional logbook and artifacts remain unchanged.

All fixture records and prototypes are SAMPLE DATA. They do not prove native
report retention, owner authorization, browser behavior, or desktop integration.
Complete supporting-document and designer-route acceptance remain open.

This installed-only probe is separate from the CI tests. It adds no test registry
exemption and changes no product source or installation.

I chose the public reader output and explicit installation input because they
exercise the installed behavior without a server or a source fallback.
I rejected a browser test because this slice excludes browsers and servers.
I rejected a new document validator because it would add a contract outside this task.

## Arena decision

Candidate 2 supplies the base: exact artifact associations and explicit missing-report output.
Candidate 1 supplies checks for saved artifacts on failed or blocked runs and unchanged files after reads.
Both candidates reuse the same fixture and installed public exports.
The final version keeps one setup helper and one reader path.
It does not add a separate validator or a CI exemption.

The original candidate results remain recorded as blocked on dependencies.
The judge used an isolated copy of existing local dependencies for fresh checks.
Candidate 1 then passed its build and 11 reader cases, but failed the repository comment rule.
Candidate 2 passed its build, repository check, seven reader cases and explicit missing-input check.
The judge selected the passing candidate; candidate branches remain unchanged.
The saved judge evidence records final verification separately from these candidate results.
