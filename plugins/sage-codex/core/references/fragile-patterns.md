# The fragile-pattern rule

This rule names four code patterns that break easily and cost much to keep, and the structural option for each one. Designers, the PE, code reviewers and security reviewers apply it, in Claude and in Codex. The aim: stop these patterns before they enter the code, and flag the ones that are there now. The owner set the rule on 2026-11-16.

## The patterns

| Pattern | Why it is fragile | The structural option |
| --- | --- | --- |
| 1. **A new hook rule** | A hook reads one host's events. Each host needs its own copy, and each new case of the event needs one more patch. | Put the rule in the state tool, the merge check or a shared rule module that both hosts call. A new hook rule needs proof that none of them can do the job. |
| 2. **One rule written twice**, once for Claude and once for Codex | The two copies drift apart, and a fix in one misses the other. | One shared implementation in core, which both thin adapters call. Two copies need proof that one shared implementation is impossible. |
| 3. **Parsing an agent's shell command to guess its intent** | Each new form of the command (a quote, an option order, a wrapper program) is a new false refusal or a new way around. | A structural boundary: a state tool command, a file permission, or a tool that takes typed fields. |
| 4. **A special case that a general rule, a table or the data could hold**: a branch on one id, one value, one provider, one task kind or one state; a second table of the same facts; a copy of a rule for one caller. The strongest sign: it is next to an earlier fix of the same area. | The cause stays, so the next case needs one more patch, and the copies drift apart. | Fix the shared cause, by the root-cause principle. Or move the case into the data, or into the one table that owns it, by the model-the-domain principle. |

## Examples from sage

- **Special cases on the hook's false refusals:** the hook refused normal commands by mistake. Four special cases fixed four forms, one at a time. Then a cause fix replaced all four, at a high cost. Pattern 4, and pattern 3 under it.
- **The stop check of the repair-rule design (T1127):** the design added a hook check at the end of an agent's turn. The owner dropped it, because the state tool's close check already holds the same rule. Pattern 1.
- **The lead slot (T1133):** the lead's slot behaved differently in each provider, and each provider got its own fix. Pattern 2.
- **A second per-state text table (T1255):** the board design gave each task state a short phrase. A second table of a text for each state, beside the state text that `board-model.mjs` has already, would repeat the same facts. The PE (R5649) named it; the design puts the phrase table in `state-words.mjs`, where it reads the task's existing step line. Pattern 4.
- **A placeholder task id (T1258):** the state tool checked a usage write with the made-up task `"T1"`, before it read the run's real task. The fix checks it with the run's task. The `no-hard-coded-ids` lint rule now refuses a task, run or gate id in product code. Pattern 4.

## How each role applies it

- **Designer:** name each pattern that the design adds, and its structural option, in the design's rules part. When the design keeps a pattern, give the proof that the option cannot do the job.
- **PE:** rate each part that adds a pattern CHANGE, and name the structural option. Rate it QUESTION only when the structural option changes what the user sees or does.
- **Code reviewer and security reviewer:** report each pattern in the change as a finding, and name its class, `fragile-pattern`, in the summary. The lead or the chief records the finding with that class, so that the board and the reports can count it.
  - The severity follows the triage rule: a pattern that breaks a function or a safety boundary, or misleads the owner, is medium or higher, with its proof.
  - Any other pattern is low. Name the structural option in its summary.
- **Chief:** in the report to the owner, name each open `fragile-pattern` finding of the task under Weak points, with its structural option.

Pattern 4 has two limits. A case that the domain truly has, such as a real variant of a discriminated union, is not a special case. Boring local code that is clear and unlikely to grow is fine.

A pattern that a task only moves or deletes is not a new pattern. A pattern that is there now, in code that the change does not touch, is a low finding for a follow-up task, not a reason for a repair round.
