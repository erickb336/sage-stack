import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./build.mjs";
import { START_LIMITS, startText } from "./start-text.mjs";

const copyPlugin = (folder) => {
  cpSync(join(ROOT, "plugins/sage"), folder, { recursive: true });
  return folder;
};

test("T1109: the start text sizes are the same at a short and a very long checkout path", async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sage-start-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const short = copyPlugin(join(dir, "s"));
  const long = copyPlugin(join(dir, ...Array.from({ length: 12 }, (_, i) => `a-very-long-checkout-folder-${i}`), "plugins", "sage"));
  assert.ok(long.length > 200, `the long path has ${long.length} characters`);

  const { chiefText } = await import(pathToFileURL(join(long, "hooks/sage-hook.mjs")).href);
  assert.equal(chiefText().split(long).length - 1, 2, "the hook's own chief text still names the long plugin folder, twice");

  for (const role of Object.keys(START_LIMITS)) {
    assert.equal((await startText(role, long)).bytes, (await startText(role, short)).bytes, `${role}: the same size at both paths`);
  }

  appendFileSync(join(long, "skills/sage/SKILL.md"), "x".repeat(100));
  assert.equal((await startText("chief-of-staff", long)).bytes, (await startText("chief-of-staff", short)).bytes + 100, "the measure reads the plugin copy that it is given");
});

test("T1195: each helper role starts without the tools that it never uses, and keeps its skills", async () => {
  const { readFileSync, readdirSync, existsSync } = await import("node:fs");
  const agents = join(ROOT, "plugins/sage/agents");
  const roles = readdirSync(agents).map((file) => file.replace(/\.md$/, "")).filter((role) => !["chief-of-staff", "lead"].includes(role));
  assert.equal(roles.length, 10, "ten helper roles");
  for (const role of roles) {
    const head = readFileSync(join(agents, `${role}.md`), "utf8").split("\n---\n")[0];
    const denied = (/^disallowedTools: (.*)$/m.exec(head)?.[1] ?? "").split(/,\s*/);
    for (const tool of ["Agent", "SendMessage", "mcp__*"]) assert.ok(denied.includes(tool), `${role} starts without ${tool}: only a lead starts an agent, no helper sends a message, and no helper uses the owner connectors`);
    assert.equal(denied.includes("Skill"), denied.includes("Edit"), `${role}: a read-only role has its principles preloaded, so Skill and its long skill list are denied exactly when the role is read-only`);
    assert.ok(!denied.includes("Bash") && !denied.includes("Read"), `${role} keeps Bash and Read`);
    for (const skill of head.match(/^ {2}- sage:(.+)$/gm) ?? []) {
      assert.ok(existsSync(join(ROOT, "plugins/sage/skills", skill.replace(/^ {2}- sage:/, ""), "SKILL.md")), `${role}: its skill ${skill.trim()} is in the plugin`);
    }
  }
});
