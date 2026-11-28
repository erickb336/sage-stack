#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer, serveStdio, z } from "../runtime/mcp-sdk.mjs";
import { tool } from "../skills/sage/sage.mjs";
import { BRIEF_FIELDS, FINDING_CLASSES, PRIORITIES, PRIORITY_SCALE } from "sage-core";
import { BRIEF_LIMIT, NAME_RULE, recordBrief } from "../hooks/brief-hook.mjs";
import { callerRefusal, CHILD_READS, NO_GATE, takeProof } from "../hooks/gate-hook.mjs";
import { TASK_NAME } from "../hooks/report-gate.mjs";

const id = (letter, what) => z.string().regex(new RegExp(`^${letter}[1-9]\\d*$`), `${what}, for example ${letter}7`).describe(what);
const task = id("T", "the task id");
const word = z.string().regex(/^(?!--)/, "a value that does not start with --");
const optional = (what) => z.string().optional().describe(what);
const count = (what) => z.union([z.number().int().nonnegative(), z.string()]).optional().describe(what);
const sha = z.string().describe("the full 40-character SHA of the head commit");
const chief = id("C", "the id of a chief of this logbook");

export const TOOLS = {
  init: { describe: "Make the project's logbook and its standing orders, or check an existing one. Run it once for a new project.", argv: () => ["init"] },
  link: {
    describe: "Only after the owner's answer in the chat: link this checkout to a logbook of the shared root (to), or start a new shared logbook for it (separate). Give one of the two.",
    input: { to: optional("the folder of an existing shared logbook, <project>-<6 hex>"), separate: z.boolean().optional().describe("true to start a new shared logbook") },
    pos: ["separate"], argv: (i) => ["link", ...(i.separate ? ["--separate"] : [])],
  },
  move: {
    describe: "Move this project's Claude and Codex logbooks into one shared logbook, when the owner asks for it. Give one of preview, plan or gate. "
      + "preview reads and changes nothing: show its text to the owner as it is. It refuses while a run runs: start no run, and tell the owner. "
      + "plan, the 8 hex of the preview's plan, opens the move gate: put its text to the owner word for word. Its options are move (or \"move, and record <provider> as unused\" when that provider has no row in plugins.tsv) and keep. "
      + "Record the owner's answer with gate_answer. Call gate, the move gate's id, only after the owner's answer in the chat: it moves, and prints the end check, the map, the backups and the restore steps. "
      + "When the logbooks changed after the preview, the plan does not match and nothing moves: show a new preview, then open a new gate. "
      + "While a move's plan is saved, every tool of the project refuses and names the gate: call move with that gate at once, from any checkout of the project, to finish it.",
    input: { preview: z.literal(true).optional().describe("true: the preview"),
      plan: z.string().regex(/^[0-9a-f]{8}$/, "the 8 hex of the preview's plan, for example 7c41e09a").optional().describe("the 8 hex of the preview's plan"),
      gate: id("G", "the move gate's id").optional() },
    pos: ["preview"], argv: (i) => ["move", ...(i.preview ? ["--preview"] : [])],
  },
  status: { describe: "Print the status lines of the project's logbook: tasks, runs, gates, releases and milestones.", argv: () => ["status"] },
  task_add: {
    describe: "Frame a task and its route. The size gives the least route; a risk flag adds the security review. Every task needs a name: 1 to 4 words, at most 32 characters, that no other open task has.",
    input: { title: z.string(), name: optional("the task's name, needed: 1 to 4 words that tell it from the other open tasks, for example Board names"), size: z.enum(Object.keys(tool.SIZES)), risk: optional(`risk flags joined by a comma: ${tool.RISKS.join(", ")}`),
      add: optional("added blocks, joined by a comma (needs why)"), why: optional("the reason for the added blocks"),
      "no-arena": optional("the owner's reason to run one designer, not the arena that a large ui or design task gets by default"),
      priority: z.enum(PRIORITIES, { error: PRIORITY_SCALE }).describe(PRIORITY_SCALE), kind: optional("the task's main kind"), waits: optional("the task ids that it waits for, joined by a comma"),
      milestone: optional("the milestone id, for example M1") },
    argv: () => ["task", "add"],
  },
  task_set: {
    describe: "Change a task: its state, branch, pr, name (1 to 4 words; the decision trail keeps the old name), request (the owner's request in the owner's words, one line; none clears it), priority, kind, waits, milestone or release (only for a task outside a milestone: a task of a milestone is in its milestone's release). drop=ux-review with why takes the UX review out of a large task whose kind is not ui or design; the size, its clean cycles and every other step stay. Resuming a round hold needs approval=<G>, an unused owner-approved repair gate for this task and round limit. The tool refuses a move that the route does not allow. Any chief may abandon a task with no owning chief: fields {\"state\": \"abandoned\"} alone, with why.",
    input: { task, fields: z.record(z.string().regex(/^[a-z]+$/), z.string()).describe('the keys and values to set, for example {"state": "building", "branch": "codex/t7-name"}'),
      why: optional("the reason of an abandon, only with the state abandoned (needed to abandon a task with no owning chief), or of drop=ux-review, which it needs") },
    pos: ["task", "fields"],
    argv: (i) => ["task", i.task, "set", ...Object.entries(i.fields).map(([k, v]) => `${k}=${v}`)],
  },
  task_names: {
    describe: "Name many tasks in one write, for a naming pass: file holds one task id, a space and its name on each line, for example T12 Board names. It checks each line and that no two open tasks share a name after all the changes; a bad line refuses the whole file, and nothing changes. A second call with the same file changes nothing and says so. Each change writes a decision row.",
    input: { file: z.string().refine(isAbsolute, "an absolute path").describe("the absolute path of the file of task ids and names") },
    argv: () => ["task", "names"],
  },
  milestone_propose: {
    describe: "Propose a milestone: one goal, a pilot task and the milestone's other tasks, framed first. It opens the breakdown gate on the pilot (approve, change or drop): put its question to the owner. "
      + "A new milestone needs name, goal, pilot and tasks. After the owner's change, or for a new pilot, give milestone, the milestone's id, with name, goal, pilot or tasks when they change. A task joins or leaves a milestone with task_set milestone=<M> or milestone=none.",
    input: { milestone: id("M", "the milestone's id, to propose it again").optional(), name: optional("the milestone's name"), goal: optional("the milestone's goal"),
      pilot: id("T", "the pilot task's id").optional(), tasks: optional("the milestone's other task ids, joined by a comma") },
    pos: ["milestone"], argv: (i) => ["milestone", "propose", ...(i.milestone ? [i.milestone] : [])],
  },
  release_add: {
    describe: "Add a release: a version that the owner ships, such as 1.0. It holds milestones and single tasks (tasks outside a milestone), and the releases keep the order in which you add them. "
      + "The name is 1 to 60 characters, unique when case and width do not count, not in the form of an id such as T12 or M5, not none, and with no comma or middle dot. "
      + "Put a milestone in it with milestone_set, and a single task with task_set release=<name>.",
    input: { name: z.string().describe("the release's name, for example 1.0"), goal: optional("the release's goal") },
    argv: () => ["release", "add"],
  },
  milestone_set: {
    describe: "Put a milestone in a release, or take it out with release none. A milestone is in at most one release, and each of its tasks is in that release. "
      + "Move a late milestone to the next release only when the owner says that its release ships: one call for each open milestone or single task. Each change writes a decision row.",
    input: { milestone: id("M", "the milestone's id"), release: z.string().describe("the release's name, or none") },
    pos: ["milestone", "release"], argv: (i) => ["milestone", i.milestone, "set", `release=${i.release}`],
  },
  config: {
    describe: "Set config keys, only when the owner asks, and print the values. name (the project's name on the board; an empty value removes it), archived (yes or no) and start (sage-mode: each new session of the project starts in sage mode, also in Claude when the two share the logbook; normal: it starts off) and lint_offer (never: the lint offer does not come back; ask: it may), commit_email and commit_name (the identity that each agent commit must carry on its command; an empty value removes it) and docs_paths (globs, joined by a comma, that also count as documentation for the docs-only merge rule; it refuses globs that together match every file) are keys of this project's logbook: set them in a call of their own. archived only for this chat's own project: an archived project takes no task or run, starts no agent and merges nothing; when the owner asks in this chat, after the archive, for new work there, set archived no first and tell the owner in one line. "
      + "cycles.small, cycles.large, cycles.risk, max_rounds, arena, cap_total and the model keys are for all projects; max_agents, max_leads and this project's cap.<project> go into a shared project's logbook, for every chief of the project.",
    input: { settings: z.record(z.string().regex(/^[a-z][a-z0-9_.-]*$/), z.string()).describe('the keys and values to set, for example {"cycles.large": "3", "max_leads": "4"} or {"name": "Council Record"}') },
    pos: ["settings"], argv: (i) => ["config", ...Object.entries(i.settings).map(([k, v]) => `${k}=${v}`)],
  },
  task_adopt: {
    describe: "Adopt another provider's task and PR from a separate logbook into an unstarted task of this project. Preserve spent repairs and provenance; require fresh destination reviews and QA. Read the source logbook without changing it. In a shared logbook it refuses and changes nothing: there, take another chief's task only through the owner's takeover gate (gate_replace, or accept for an offer to you).",
    input: { task, "source-logbook": z.string().refine(isAbsolute, "an absolute path"), "source-provider": z.string(), "source-task": task,
      pr: z.string().regex(/^[1-9]\d*$/), branch: z.string() },
    pos: ["task"], argv: i => ["task-adopt", i.task],
  },
  run_add: {
    describe: "Record an agent run of a task before the agent starts. It prints the run id, and the reasoning_effort to give spawn_agent when the role has one.",
    input: { task, role: z.string().describe("lead, implementer, pe, designer, arena-judge, code-reviewer, security-reviewer, ux-reviewer, qa, investigate or evidence-review"),
      branch: optional("the run's branch; needed for an implementer, an arena-judge and an arena candidate, not for a designer outside an arena"), candidate: count("the arena candidate number"),
      "usage-interface": optional("collaboration-tools, for a Codex agent: its agent tools give no token count, so the report gate keeps the count at the agent's stop") },
    pos: ["task"], argv: (i) => ["run", "add", i.task],
  },
  run_done: {
    describe: "Record the end of a run. A done review, QA or evidence-review run needs tokens. For a run added with usage-interface collaboration-tools, the report gate keeps the token count at its agent's stop, "
      + "and run_done records it; usage unavailable stands only when the gate kept none. Save its report with pages (task, run and text), then end it as done with usage unavailable, usage-source, usage-evidence, the path that pages printed as report, and no tokens, for example "
      + '{"project": "/absolute/project", "run": "R40", "status": "done", "usage": "unavailable", "usage-source": "codex collaboration-tools", "usage-evidence": "wait_agent gives no token count", "report": "<the path that pages printed>"}.',
    input: { run: id("R", "the run id"), status: z.enum(["done", "blocked", "question", "failed"]), tokens: count("the run's tokens, a whole number"),
      report: optional("the absolute path of the saved report, as pages printed it; needed with usage unavailable"),
      usage: optional("unavailable, only for a run added with usage-interface collaboration-tools; it needs status done, usage-source, usage-evidence and report, and no tokens"),
      "usage-source": optional("where the usage comes from, for example codex collaboration-tools; needed with usage unavailable"),
      "usage-evidence": optional("the evidence of the usage, for example wait_agent gives no token count; needed with usage unavailable"),
      why: optional("why the run failed, one line of at most 200 characters that the board shows the owner; needed with status failed, and a failed run that lacks it may add it later, once") },
    pos: ["run"], argv: (i) => ["run", "done", i.run],
  },
  finding_add: {
    describe: "Record a finding of a review or QA. A known key opens it again. A review or QA finding needs run and class.",
    input: { task, source: z.string().describe("the role that found it, for example code-reviewer"), severity: z.enum(["high", "medium", "low"]),
      summary: optional("the location and the steps that show it"), key: optional("a known finding key, to open it again"),
      run: optional("the run whose report holds the finding; needed for a review or QA source"),
      class: optional(`${FINDING_CLASSES.slice(0, -1).join(", ")} or ${FINDING_CLASSES.at(-1)}; needed for a review or QA source`) },
    pos: ["task"], argv: (i) => ["finding", "add", i.task],
  },
  finding_triage: {
    describe: "Triage a finding: fix, dismiss (needs a reason, or proof) or ask the owner. proof names the done proof check (a qa run) whose report reran the finding's proof on its head: reproduced or could not run backs fix, not reproduced backs dismiss.",
    input: { task, key: z.string().describe("the finding key, for example F-T7-1"), decision: z.enum(["fix", "dismiss", "ask"]), reason: optional("the reason, needed to dismiss without proof"),
      proof: id("R", "the run id of the proof check").optional() },
    pos: ["task", "key", "decision"], argv: (i) => ["finding", "triage", i.task, i.key, i.decision],
  },
  finding_close: {
    describe: "Close a fixed finding. In a repair round, close each fix key after the repair's commit, before the task moves to reviewing.",
    input: { task, key: z.string().describe("the finding key") }, pos: ["task", "key"], argv: (i) => ["finding", "close", i.task, i.key],
  },
  finding_move: {
    describe: "Move an open medium or low finding to a new follow-up task, which the tool frames (to, the title, and size), or into an open task of this logbook (into, the task id). Give to or into. The finding arrives triaged fix: close it after a re-check confirms the fix. A fix key of the task's current round moves with why when it is low, and only after the owner's gate when it is medium.",
    input: { task, key: z.string().describe("the finding key"), to: optional("the title of a new follow-up task, never a task id"), into: id("T", "an open task to move the finding into").optional(), size: optional("tiny, small or large (small by default); not with into"),
      why: optional("the reason of the move, which the decision trail keeps; needed for a low fix key of the current round") },
    pos: ["task", "key"], argv: (i) => ["finding", "move", i.task, i.key],
  },
  verdict: {
    describe: "Record a verdict of checks, a review or QA on a head SHA. Record medium and high findings before a problem verdict.",
    input: { task, kind: z.enum(tool.KINDS), sha: sha.optional(), cycle: count("the cycle number"), pr: count("the pull request number"), run: optional("the run id of the review or QA") },
    pos: ["task"], argv: (i) => ["verdict", i.task],
  },
  lint: {
    describe: "Lint a head SHA of a task with the rules of the tip of origin/main: it scans the lines that the commit adds since its merge base with origin/main, with the root sgconfig.yml of origin/main, and records lint-pass or lint-fail. It prints each problem with its file and line, and the files that it did not check. When origin/main has no sgconfig.yml, lint records nothing, and its first run opens the lint offer, a gate for the owner (add the rules, not now, never for this project): ask it as any gate. The answer add frames a small task with its brief in the task's pages folder. Run it before merge_check; a lead may run it on its own task.",
    input: { task, sha }, pos: ["task"], argv: (i) => ["lint", i.task],
  },
  unclaim: {
    describe: "Give up your task: the next pick-up of another chief takes it, and you get it back only through the owner's takeover gate. The task needs no active run. Its work and reports stay.",
    input: { task }, pos: ["task"], argv: (i) => ["unclaim", i.task],
  },
  pickup: {
    describe: "Take the work of each stopped session (open tasks, runs, queued runs, open gates) and the tasks with no owning chief, in one locked write. Every write of yours does this first; call it alone to see what passes to you. Tell the owner in one line what you picked up, and start each lost run again.",
    argv: () => ["pickup"],
  },
  round: { describe: "Start a repair round on the open findings marked fix, also on low findings only. It names the roles to run again. Past max_rounds it holds the task; while autopilot is on, the chief gives the next round itself with why, up to 5 rounds in all, also from that hold.",
    input: { task, why: optional("the chief's reason for an extra round past max_rounds") }, pos: ["task"], argv: (i) => ["round", i.task] },
  merge_check: {
    describe: "Check that the logbook allows the merge of this head SHA: clean cycles, no open findings, no open gates. A docs-only head (each changed file is documentation) needs no cycle, only checks-pass and lint, and the message, also a refusal, says so: a lead calls it after CI and before the reviews. It judges for your chief: a task of another chief refuses.",
    input: { sha, pr: count("the pull request number"), cycles: count("a higher count of clean cycles"), head: optional("the pull request's branch") },
    argv: () => ["merge-check"],
  },
  log: {
    describe: "Add a line to the decision trail. Put the id that the decision is about first.",
    input: { task: z.union([task, z.literal("-")]).describe("the task id, or - for none"), decision: word.describe("the decision"), why: z.string().describe("the reason") },
    pos: ["task", "decision"], argv: (i) => ["log", i.task, i.decision],
  },
  worktrees: {
    describe: "List the git worktrees of the project's repository, each with its path, branch, task, task state and reason: merged, concluded, abandoned, branch merged, open or unknown. It reads the local origin/main and does not fetch. "
      + "With prune true, after you showed the list, it removes each clean worktree of a merged, concluded or abandoned task, or of a branch that a merge brought into origin/main, and prints each path that it removes or keeps with the reason. It keeps the primary checkout, the project's own worktree, a locked one, one that holds another worktree, and one with changes, untracked files, ignored files or unpushed commits, and it deletes no branch. Only an ignored node_modules or dist folder or link keeps no worktree: the prune deletes it with the worktree and names it.",
    input: { prune: z.literal(true).optional().describe("true: remove the clean worktrees that may go") },
    pos: ["prune"], argv: (i) => ["worktrees", ...(i.prune ? ["prune", "--yes"] : [])],
  },
  standing: { describe: "Print the standing orders as written. Every agent reads them before it starts; a brief points to them.", argv: () => ["standing"] },
  standing_add: { describe: "Add one standing order.", input: { order: word.describe("the order") }, pos: ["order"], argv: (i) => ["standing", "add", i.order] },
  pages: {
    describe: "Make and print the folder where agents save the task's pages, or record a page there (its path and sha256) in the decision trail. "
      + "With run and text, it saves that run's exact report in the folder and records it. Known retained text must match before the first save. Give the printed path as run_done's report; reuse the printed sha256 for report_compare.",
    input: { task, record: z.string().refine(isAbsolute, "an absolute path").optional().describe("the absolute path of a page in that folder, to record it"),
      run: optional("a run of the task, with text: whose report to save"), text: optional("the run's whole report, with run: the text to save") },
    pos: ["task", "record"], argv: (i) => ["pages", i.task, ...(i.record === undefined ? (i.text === undefined && i.run === undefined ? [] : ["record"]) : ["record", String(i.record)])],
  },
  prior_art: {
    describe: "The prior-art index, one Markdown table for each topic in the shared root's prior-art folder, the same folder as Claude's. With no topic: the folder and its topics. With topic: print the topic's rows, to put in a brief's CONTEXT. "
      + "With topic and file (or rows): add the rows that an agent proposed in the file that its report names (the table rows of the prior-art rule: Name, What they do, What we take, Where we differ and why, Link, Read on). It refuses a bad row and adds nothing; it keeps out a row whose link is in the topic already.",
    input: { topic: z.string().optional().describe("the topic, 1 to 40 lower-case letters, digits and dashes, for example reviews"),
      file: z.string().refine(isAbsolute, "an absolute path").optional().describe("the absolute path of the file of rows that a report names"), rows: optional("the table rows to add, one row on each line") },
    pos: ["topic"], argv: (i) => ["prior-art", ...(i.topic === undefined ? [] : [i.topic]), ...(i.rows === undefined && i.file === undefined ? [] : ["add"])],
  },
  message: {
    describe: "Print a message to the owner in the shape of its kind, from its JSON (the presentation skill gives each kind and its parts), and write its page in the task's pages folder when it has a picture or is long. "
      + "Show the printed text to the owner word for word: a pictured message ends with its Page block. A message that is not in its kind's shape is refused with each problem.",
    input: { task, message: z.record(z.string(), z.unknown()).describe("the message: { kind, title, blocks, ref }, as the presentation skill gives it") },
    pos: ["task", "message"], argv: (i) => ["message", i.task, `--json=${JSON.stringify(i.message)}`],
  },
  gate_add: {
    describe: "Park a question for the owner, with options, a recommendation and a default, and its question message: the gate keeps the whole message for the board, after the message check. When the task's pages folder holds a page, the message names the main page with a Page block { t: page, title, task, file }; it may name another task's page. "
      + "For the owner's approval of a design, give design instead of options: the gate has the three fixed choices Approve, Approve with your words and New version. An approval copies the design into the logbook and moves the task from awaiting-you to briefed; New version moves it to designing.",
    input: { task, question: z.string(), options: optional("the options joined by |, for example yes|no; none with design"), recommend: z.string().describe("the recommended option"),
      design: optional("the design's page or folder in the task's pages folder, for example designs/final: the gate is a design question"),
      default: optional("the default option"), message: z.string().refine(isAbsolute, "an absolute path").describe("the absolute path of the question message's JSON file ({ kind: \"question\", title, blocks })"),
      run: id("R", "the run of this task that asked the question, for the board").optional() },
    pos: ["task"], argv: (i) => ["gate", "add", i.task],
  },
  gate_replace: {
    describe: "The takeover gate: ask the owner to give a task of another, live chief, or a task that you unclaimed, to a chief (to). The gate names each run that ends as failed. The owner's answer does the takeover, through gate_answer. task may be a list of task ids joined by commas, such as T4,T7,T9, all of one owning chief: one question moves them all on approve and none on decline.",
    input: { task: z.string().regex(/^T[1-9]\d*(?:,T[1-9]\d*)*$/, "a task id, or task ids joined by commas, for example T7 or T4,T7").describe("the task id, or task ids joined by commas"), to: chief }, pos: ["task"], argv: (i) => ["gate", "replace", i.task],
  },
  gate_answer: {
    describe: "Record the owner's answer to a gate: the option's number, or the owner's own words as the hex of their UTF-8 bytes, and via, where the owner answered: codex-card for your choice card, chat for the chat. board only records the owner's board answer as pending: it acts when the owning chief's hook picks it up, and gate_undo takes it back before that. The first answer wins: a gate with an answer refuses, and names that answer, its place and its time.",
    input: { gate: id("G", "the gate id"), option: count("the number of the option"), "other-hex": optional("the owner's own words, as lower-case hex of their UTF-8 bytes"),
      via: z.enum(["codex-card", "chat", "claude-card", "board"]).optional().describe("where the owner answered; chat when left out") },
    pos: ["gate"], argv: (i) => ["gate", "answer", i.gate],
  },
  gate_undo: {
    describe: "Only when the owner asks: take back the owner's board answer to a gate before a chief picks it up. After the pickup, or for an answer from a card or the chat, it refuses and says why.",
    input: { gate: id("G", "the gate id") }, pos: ["gate"], argv: (i) => ["gate", "undo", i.gate],
  },
  gate_give: {
    describe: "Only when the owner asks: open the takeover gate that gives a task to a chief (to), the same one-recipient gate as gate_replace, as the owner's act. The receiving chief applies the owner's answer.",
    input: { task, to: chief }, pos: ["task"], argv: (i) => ["gate", "give", i.task],
  },
  chief_name: {
    describe: "Only when the owner asks: give a chief (chief) the owner's name for it on the board (name), as the owner's act. With no name, it clears the name, and the board shows the default name: provider · folder · start time.",
    input: { chief, name: optional("the name: 1 to 60 characters, with no space at its start or end and no two spaces together") }, pos: ["chief", "name"], argv: (i) => ["chief", "name", i.chief, ...(i.name ? [i.name] : [])],
  },
};

export function argvFor(name, input) {
  const { pos = [], argv } = TOOLS[name];
  const options = Object.entries(input).filter(([key, v]) => key !== "project" && !pos.includes(key) && v !== undefined);
  return [...argv(input), ...options.map(([key, v]) => `--${key}=${v}`), `--project=${input.project}`];
}

export function createStateServer({ env = process.env } = {}) {
  const server = new McpServer({ name: "sage", version: "0.1.0" });
  const registerTool = (name, spec, run) => server.registerTool(name, spec, async (input, extra) => {
    const caller = takeProof(extra?.mcpReq?._meta, name, env, input);
    const why = caller ? callerRefusal(caller, name, input, env) : NO_GATE;
    return why ? { isError: true, content: [{ type: "text", text: why }] } : run(input, caller, extra?.mcpReq?._meta?.sessionId);
  });
  const project = z.string().refine(isAbsolute, "an absolute path").describe("the absolute path of the project's checkout");
  for (const [name, spec] of Object.entries(TOOLS)) {
    registerTool(name, {
      description: spec.describe,
      inputSchema: z.object({ project, ...spec.input }).strict(),
      annotations: { readOnlyHint: CHILD_READS.has(name), destructiveHint: false },
    }, async (input, caller, native) => {
      if (name === "pages" && input.record !== undefined && (input.run !== undefined || input.text !== undefined))
        return { isError: true, content: [{ type: "text", text: "sage: pages takes record or inline run and text, not both. Nothing saved." }] };
      if (name === "pages" && input.record === undefined && input.run !== undefined && input.text?.trim()
        && Buffer.byteLength(input.text) <= 16 * 1024 * 1024) {
        try {
          const { status } = tool.compareRetainedReport({ project: input.project, task: input.task, run: input.run,
            sha256: createHash("sha256").update(input.text, "utf8").digest("hex") }, env);
          if (status === "mismatch" || status === "damaged") return { isError: true, content: [{ type: "text", text: status === "mismatch"
            ? `sage: ${input.run} text does not match the retained report. Nothing saved. Give the helper's exact report, including Markdown, spaces and newlines.`
            : `sage: ${input.run} retained report is damaged. Nothing saved. Report this limitation; do not replace the retained report.` }] };
        } catch (error) {
          if (!/^Invalid retained report comparison (?:input|task or run association)\.$/.test(error.message))
            return { isError: true, content: [{ type: "text", text: `sage: ${error.message}` }] };
        }
      }
      const { code, text } = tool.command(argvFor(name, input), env, { project: input.project, native, leadTask: caller.role === "lead" ? caller.task : undefined });
      return { ...(code ? { isError: true } : {}), content: [{ type: "text", text }] };
    });
  }
  registerTool("report_compare", {
    description: "Chief only: compare an existing retained role report with the SHA256 of exact UTF-8 text. Returns only match, mismatch, missing or damaged. This observed snapshot grants no review approval or native authenticity.",
    inputSchema: z.object({ project, task, run: id("R", "the run id"), sha256: z.string().regex(/^[0-9a-f]{64}$/).describe("SHA256 of the exact UTF-8 report text, without normalization") }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async input => {
    try { return { content: [{ type: "text", text: JSON.stringify(tool.compareRetainedReport(input, env)) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text", text: `sage: ${error.message}` }] }; }
  });
  registerTool("brief", {
    description: `Check a role agent's brief before you spawn it: it names each missing field of ${BRIEF_FIELDS.join(", ")}, and keeps the brief for the agent's start note. Fix the brief and run it again until no field is missing, then spawn the agent with the same task name and brief. The gate starts a sage_ agent only in the 30 minutes after its brief is checked.`,
    inputSchema: z.object({ project, task_name: z.string().regex(TASK_NAME, NAME_RULE).describe("the task_name of the spawn"),
      brief: z.string().max(BRIEF_LIMIT).describe("the whole brief, each field at the start of a line") }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async ({ project: folder, task_name: task, brief }, caller, session) => {
    let missing;
    try { missing = recordBrief(folder, task, brief, env, session); } catch (error) { return { isError: true, content: [{ type: "text", text: `sage: ${error.message}` }] }; }
    const text = missing.length
      ? `sage: the brief of ${task} has no ${missing.join(", ")}. Every brief has all of ${BRIEF_FIELDS.join(", ")}, each at the start of a line that is not in a list or a code block, with a colon, two spaces or a tab after its name (GOAL: …, GOAL   …), or its name alone on the line. Add them, then run brief again.`
      : `brief ${task} checked: all ${BRIEF_FIELDS.length} fields. Spawn the agent with this task name and this brief.`;
    return { ...(missing.length ? { isError: true } : {}), content: [{ type: "text", text }] };
  });
  return server;
}

let entry;
try { if (process.argv[1]) entry = realpathSync(process.argv[1]); } catch {}
if (entry === fileURLToPath(import.meta.url)) serveStdio(() => createStateServer());
