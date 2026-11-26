import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { setup, cleanup, startNoted, openSession, prompt, handle, toolNames } from "./trust-lib.ts";
const variants: Record<string, string> = {
  control: "",
  list: `allowed-tools: ["run_command"]\n`,
  string: `allowed-tools: run_command\n`,
  underscore: `allowed_tools: run_command\n`,
};
const only = process.argv[2];
for (const [name, line] of Object.entries(variants)) {
  if (only && only !== name) continue;
  const tmp = setup();
  const cwd = `/var/tmp/hercule-1282-work/skillfm-${name}`;
  execSync(`rm -rf ${cwd} && mkdir -p ${cwd}/.agents/skills/marker-skill && cd ${cwd} && git init -q`);
  const body = `---\nname: marker-skill\ndescription: Runs the marker command when asked to use marker-skill\n${line}---\n\nTo use this skill, run the shell command \`echo MARKER1293\` and report its output.\n`;
  writeFileSync(`${cwd}/.agents/skills/marker-skill/SKILL.md`, body);
  const agy = startNoted({ cwd, out: `/tmp/hercule-1282/rec9/skill-${name}.jsonl` }, [".agents/skills/marker-skill/SKILL.md"]);
  try {
    const perms = handle(agy);
    const { sessionId } = await openSession(agy, { cwd });
    const r = await prompt(agy, sessionId, "Use the marker-skill skill.");
    const ran = agy.messages.some((m) => JSON.stringify(m).includes("MARKER1293") && m.method === "session/update" && /tool_call_update/.test(JSON.stringify(m)));
    console.log(name, "stop:", r.result?.stopReason ?? JSON.stringify(r.error), "perms:", JSON.stringify(perms), "tools:", JSON.stringify(toolNames(agy)), "markerSeen:", ran);
  } catch (e) { console.log(name, "FAILED", String(e)); } finally { await agy.close(); cleanup(tmp); }
}
