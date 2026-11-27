# Design

The chief reads this playbook at the moment that its line in the chief's text names, and follows its five parts. In the owner's moment, the recommendation comes first, and the message says what happens with no answer before it asks; the presentation skill has the shape of each message kind. The logbook records the answer (the gate's answer, or `sage log`), and the task's next brief starts with it, in DECISIONS. Teach the idea of the last part in one short paragraph, the first time that the owner meets it.

1. **How the chief knows:** the task changes what a user sees or meets: a screen, a message, a word in the product, or a process that the owner takes part in.
2. **Agents prepare:** the designer (or an arena), then the PE check. The brief names the sage plugin's folder, so that the designer reads the design format, `core/references/design-format.md`, and runs its check, `core/design-page.mjs`. The design is one page in that format:
   - The ten parts in order: the real story, the story after the change, how it works, what the owner will see, what the agents do, the rules, the owner's choices, the cost and plan, and last, under the hood.
   - The diagrams that fit the design: a state chart for how a thing moves between states, an architecture diagram for parts and links, a flow chart for steps and decisions. Each one in the presentation skill's picture rules, and readable with no click.
   - Every state side by side: empty, loading, error and success. For a process design, the surfaces that the owner meets.
   - Sample data, labelled as sample.
   - 2 or 3 options for each open choice, and the cost of each option.
   - The prior art, by the prior-art rule (`core/references/prior-art.md`): 2 or 3 existing products or tools, read from fetched sources, and the one that each option follows, or how and why it differs. Part 4 links each source.
   - The fragile patterns, by the fragile-pattern rule (`core/references/fragile-patterns.md`): in the rules part, each one that the design adds and its structural option. The PE check rates each one CHANGE.
   - The cases that the design does not decide (see **Undecided case**, `undecided-case.md`).
3. **The owner's moment:** message kind `design`, with the design page as its page. Before you send it, run the design check on the page: a page that fails goes back to the designer. The message says what changes for the owner, the options and the cost. The recommendation is first.
   - Answers: pick A, B or C, or pick one and mark the parts of the others to keep.
   - If the owner does not answer: nothing is built. Other tasks go on.
   - For the approval of the final design, open a design question (`sage gate add <T> --design <its page or folder>`): Approve, Approve with your words, or New version. After choice 2, ask for the words.
4. **After the answer:** the gate's answer records the pick. The pick and the dropped options stay in the task's pages folder. An approval keeps a copy of the design in the logbook and moves the task to the build; New version sends it back to the designer. The UX review compares the build with the approved design.
5. **The owner learns:** **sample data.** A prototype uses made-up data, so that the owner judges the experience, not the numbers. Example: the autopilot design used made-up tasks. The owner approved the design only; the build was a separate step.
