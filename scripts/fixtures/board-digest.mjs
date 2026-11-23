export const NOW = "2026-11-23T15:43:00Z";
const ago = minutes => new Date(Date.parse(NOW) - minutes * 60_000).toISOString().replace(".000", "");
const task = (id, title, state, extra = {}) => ({ id, title, size: "small", risk: "", route: "build,code-review,qa", state, branch: "", pr: "", round: "0", keys: "", hold: "", priority: "P1", kind: "bug-fix", waits: "", milestone: "", ...extra });
const run = (id, on, role, minutes) => ({ id, task: on, role, status: "running", started: ago(minutes), tokens: "1" });
const done = (on, state, minutes) => ({ task: on, decision: `state ${state}`, why: "sample", at: ago(minutes) });
const head = "c0ffee1".padEnd(40, "0");
const pr = (id, on, number) => ({ id, task: on, kind: "pr", source: "Sample", observedAt: ago(1), data: { number, state: "open", head, repository: "https://github.com/sample/sage" } });

export const LONG_TITLE = "Hook slots free themselves when a session dies, so that a crashed hook never blocks the next agent";

export function digestSources() {
  const stack = {
    key: "claude/sage-stack-aaaaaa", name: "sage-stack-aaaaaa", displayName: "sage-stack", checkout: "/sample/sage-stack", diagnostics: [], shared: true,
    chiefs: [{ id: "C1", provider: "claude", at: ago(600) }, { id: "C2", provider: "claude", at: ago(300) }],
    chiefLive: { C1: { at: Date.parse(ago(200)), ended: "prompt_input_exit", endedAt: Date.parse(ago(190)) }, C2: { at: Date.parse(ago(1)) } },
    chiefNames: {},
    tables: {
      tasks: [
        task("T1204", LONG_TITLE, "building", { branch: "claude/t1204", chief: "C2", milestone: "M7" }),
        task("T1206", "The board answers while it reads the logbook", "reviewing", { pr: "640", chief: "C2", milestone: "M7" }),
        task("T1205", "Pages link to the board only when it runs", "verified", { pr: "645", chief: "C2" }),
        task("T1199", "Read-only roles cannot write into the agent folders", "merged", { pr: "641", chief: "C2", milestone: "M7" }),
        task("T1190", "The design check counts two prior-art links", "merged", { pr: "630", chief: "C2" }),
        task("T1180", "An old merge from last week", "merged", { pr: "600", chief: "C2" }),
        task("T1150", "A task in the backlog that nobody started", "framed", { chief: "C1" }),
        task("T1151", "A second task in the backlog", "framed", { chief: "C1" }),
        task("T1210", "Pick the layout of the release notes", "framed", { chief: "C2", milestone: "M7" }),
      ],
      gates: [{ id: "G200", task: "T1199", question: "Approve milestone M7? No task builds before you approve.", options: "approve|change|drop", recommendation: "approve", default: "", answer: "approve", at: ago(6000) },
        { id: "G236", task: "T1210", question: "Which layout do the release notes use?", options: "one page|one page for each project", recommendation: "one page", default: "", answer: "", at: ago(30) }],
      runs: [run("R5300", "T1204", "implementer", 20), run("R5301", "T1206", "code-reviewer", 5)],
      decisions: [done("T1199", "merged", 63), done("T1190", "merged", 24 * 60 - 60), done("T1180", "merged", 3 * 24 * 60)],
      milestones: [{ id: "M7", name: "Board redesign", goal: "Sample goal.", pilot: "T1199", gate: "G200", at: ago(5000) }],
    },
    observations: { records: [pr("O1", "T1206", 640), pr("O2", "T1205", 645)] },
  };
  const sedalina = {
    key: "claude/sedalina-bbbbbb", name: "sedalina-bbbbbb", displayName: "sedalina", diagnostics: [],
    tables: {
      tasks: [task("T88", "Choose the checkout layout", "awaiting-you"), task("T89", "Fix the cart total", "building")],
      gates: [{ id: "G62", task: "T88", question: "Checkout layout: A (one page) or B (three steps)?", options: "A|B", recommendation: "A", default: "", answer: "", at: ago(90) }],
      runs: [run("R12", "T89", "implementer", 75)],
    },
  };
  const quiet = { key: "claude/quiet-app-cccccc", name: "quiet-app-cccccc", displayName: "quiet-app", diagnostics: [], tables: { tasks: [task("T3", "Someday: a dark mode", "framed")] } };
  return [{ id: "claude", label: "claude", provider: "Claude", diagnostics: [], projects: [stack, sedalina, quiet] }];
}
export const landing = () => ({ ok: true, scope: "global", reason: "" });
