// Which instruction files and rules agy reads. One file per place, each with its own marker tag.
import { join } from "node:path";
import { MARKER_PROMPT, markerLine, runScenario } from "../driver.ts";

await runScenario("instructions-files", "which instruction files reach the session: the Harness Home's GEMINI.md, AGENTS.md, config/GEMINI.md, config/AGENTS.md and the files of config/rules/ with trigger: always_on, and the working folder's AGENTS.md, GEMINI.md and .agents/rules with trigger: always_on, are read; rules with trigger manual or model_decision, rules with no frontmatter, antigravity-acp/GEMINI.md and everything under the fake HOME are not; --include-default-customizations=false changes nothing", async (run) => {
  const cwd = join(run.work, "cwd");
  const rule = (trigger: string | null, tag: string) =>
    trigger === null ? markerLine(tag) : `---\ntrigger: ${trigger}\n${trigger === "model_decision" ? "description: Use when the user asks for marker tags.\n" : ""}---\n${markerLine(tag)}`;
  // The Harness Home.
  run.place("home", "GEMINI.md", markerLine("MARKER-HOMEGEMINI"));
  run.place("home", "AGENTS.md", markerLine("MARKER-HOMEAGENTS"));
  run.place("home", "config/GEMINI.md", markerLine("MARKER-CONFIGGEMINI"));
  run.place("home", "config/AGENTS.md", markerLine("MARKER-CONFIGAGENTS"));
  run.place("home", "config/rules/h1293-always.md", rule("always_on", "MARKER-CONFIGRULEALWAYS"));
  run.place("home", "config/rules/h1293-manual.md", rule("manual", "MARKER-CONFIGRULEMANUAL"));
  run.place("home", "config/rules/h1293-decision.md", rule("model_decision", "MARKER-CONFIGRULEDECISION"));
  run.place("home", "config/rules/h1293-plain.md", rule(null, "MARKER-CONFIGRULEPLAIN"));
  run.place("home", "antigravity-acp/GEMINI.md", markerLine("MARKER-APPGEMINI"));
  // The working folder.
  run.place("work", "cwd/AGENTS.md", markerLine("MARKER-CWDAGENTS"));
  run.place("work", "cwd/GEMINI.md", markerLine("MARKER-CWDGEMINI"));
  run.place("work", "cwd/.agents/rules/a.md", rule("always_on", "MARKER-CWDRULEALWAYS"));
  run.place("work", "cwd/.agents/rules/m.md", rule("manual", "MARKER-CWDRULEMANUAL"));
  run.place("work", "cwd/.agents/rules/d.md", rule("model_decision", "MARKER-CWDRULEDECISION"));
  run.place("work", "cwd/.agents/rules/p.md", rule(null, "MARKER-CWDRULEPLAIN"));
  // The fake HOME.
  run.place("fakehome", ".gemini/GEMINI.md", markerLine("MARKER-FAKEDOTGEMINIGEMINI"));
  run.place("fakehome", ".gemini/AGENTS.md", markerLine("MARKER-FAKEDOTGEMINIAGENTS"));
  run.place("fakehome", "GEMINI.md", markerLine("MARKER-FAKEHOMEGEMINI"));
  run.place("fakehome", ".agents/AGENTS.md", markerLine("MARKER-FAKEDOTAGENTSAGENTS"));

  const done = run.watch({ cwd, fakeHome: run.fakeHome, TMPDIR: run.tmp });
  const sessions: string[] = [];
  for (const flags of [[], ["--include-default-customizations=false"]]) {
    const agy = run.start({ cwd, flags });
    const session = await agy.newSession({ cwd });
    sessions.push(session.sessionId);
    await run.ask(agy, session.sessionId, MARKER_PROMPT, 90_000, { flags });
    if (flags.length === 0) {
      await run.ask(agy, session.sessionId, "Now, in the order they appear in your instructions from top to bottom, list each marker tag with the file path or heading shown just before it, and name any rule file your instructions mention without its content. Do not use any tools.", 90_000, { step: "order and source of each instruction" });
    }
    await agy.close();
  }
  done();
  // The stored first steps of each session: the user request as agy stored it, and the reply (without the model's thinking).
  run.observed.storedFirstSteps = sessions.map((id) => ({ sessionId: id, firstSteps: run.transcript(id).slice(0, 2).map(({ thinking: _thinking, ...rest }) => rest) }));
});
