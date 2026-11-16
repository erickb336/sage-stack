# The prior-art rule

This rule says how an agent finds and reports the prior art of a design, an engineering check (PE), an arena or an investigation: the existing stacks, tools and products that do the same job. The aim is a few relevant sources that the agent read, not a list from memory. The same text holds in Claude and in Codex.

## Search

1. **Write the problem first,** in one line: what must work, and its limits (for example: local only, many agents at once, any language). Search by that line, not by the answer that you have in mind.
2. **Check sage's own history first:** the rows of the prior-art index that your brief gives in CONTEXT, the earlier tasks and decisions of the logbook, and earlier research pages. Do not search again for a source that the index has, unless your question needs a newer fact.
3. **Scan wide:** 10 to 20 candidates. Look in this order:
   1. other agent stacks: pstack, superpowers, BMAD, spec-kit, OpenHands, Aider, and Claude Code and Codex skills;
   2. the owner's trusted list (it starts with pstack);
   3. mature tools in the area;
   4. classic practice, as background only.
4. **Score the fit** of each candidate: the same problem; the same limits; still maintained; evidence of use. Keep the top 2 or 3.
5. **Read the top 2 or 3 from fetched sources:** the raw page, the README, the code or the paper. Never from memory, and never from a summary alone. Note the date that you read each one.
6. **Include failures and one opposite example:** an issue, a postmortem or a "why we stopped" post, and one tool that solves the same problem in the opposite way.

When you could fetch no source, say so in NOT VERIFIED. Do not fill the table from memory.

## The prior-art table

Report the sources that you read in this table, with these columns only:

| Name | What they do | What we take | Where we differ, and why | Link | Read on |
| --- | --- | --- | --- | --- | --- |
| pstack (sample) | Ships each principle as a skill | The frontmatter of a principle | sage adds a hook, because a prompt alone is not enough | https://github.com/... | 2026-11-16 |

- **Link:** the `http` or `https` address of the page that you read. A local file or a sage page does not count.
- **Read on:** the date, as YYYY-MM-DD.
- Write "nothing" in "What we take" for the opposite example.

Where the table goes:

- **Designer and arena judge:** the full table in the rationale. On the design page, part 4 has the prior art in one line, with a link to each source; the design check counts at least 2 links (`core/references/design-format.md`).
- **PE:** in RESULT, for the plan's prior art. When the plan names none, find it.
- **Investigate:** on the research page.

## The prior-art index

The index keeps the sources that earlier runs read, so that the next run starts from them. It is one folder in sage's data root on the owner's Mac, `prior-art/` in the shared root (`~/.sage/prior-art/`), with one Markdown file for each topic, such as `reviews.md`, `boards.md` or `verification.md`. Each file holds one prior-art table. Claude and Codex read and write the same folder.

- **An agent reads** the rows that its brief gives in CONTEXT. It does not run the state tool.
- **An agent proposes** new rows at the end of its RESULT, in this form, and never writes the index:

  ```
  Prior-art index <topic>:
  | Name | What they do | What we take | Where we differ, and why | Link | Read on |
  | <one row for each source that you read> |
  ```

- **The chief** puts a topic's rows in the brief's CONTEXT: `sage prior-art <topic>` prints them (Codex: the `prior_art` tool with `topic`). `sage prior-art` lists the topics.
- **The chief adds** the proposed rows: `sage prior-art <topic> add --rows "<the rows>"` (Codex: `prior_art` with `topic` and `rows`). The tool refuses a bad row and adds nothing. It keeps out a row whose link is in the topic already.
