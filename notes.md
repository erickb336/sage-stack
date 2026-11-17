# Candidate 2: installed arena reader associations

This candidate probes the installed reader with fictional shared-logbook records.
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

All fixture records and prototypes are SAMPLE DATA. They do not prove native
report retention, owner authorization, browser behavior, or desktop integration.
Complete supporting-document and designer-route acceptance remain open.

This installed-only probe is separate from the CI tests. It adds no test registry
exemption and changes no product source or installation.

I chose the public reader output and explicit installation input because they
exercise the installed behavior without a server or a source fallback.
I rejected a browser test because this slice excludes browsers and servers.
I rejected a new document validator because it would add a contract outside this task.

## Recorded result

The installed probe passed all seven cases with no skips. Missing installation
input failed explicitly, as required. The build failed because React dependencies
were missing. The repository check failed because `@ast-grep/cli/postinstall.js`
was missing. Dependency installation was outside this task's permitted scope.
These results do not establish a passing build or repository check.
