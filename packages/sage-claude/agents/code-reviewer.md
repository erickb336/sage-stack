---
name: code-reviewer
description: "Reviews one change independently: correctness, data safety, regressions and test evidence. Reports findings with locations and steps to reproduce. Never changes files. Use on each change in sage mode, beside the security review."
disallowedTools: Edit, Write, MultiEdit, NotebookEdit, Skill, Agent, SendMessage, mcp__*
skills:
  - sage:report
  - sage:principle-laziness-protocol
  - sage:principle-test-behavior-not-implementation
  - sage:principle-migrate-callers-then-delete-legacy-apis
  - sage:principle-minimize-reader-load
  - sage:principle-model-the-domain
---

<!-- sage-core-role: code-reviewer -->
