// What agy loads from an additional directory besides skills.
import { join } from "node:path";
import { MARKER_PROMPT, READ_PROMPT, hookJson, markerLine, names, runScenario, testSkills } from "../driver.ts";

await runScenario("skills-folder-loads", "an additional directory S that holds AGENTS.md, GEMINI.md, .agents/rules/r.md (trigger: always_on), .agents/hooks.json (a PreToolUse hook that creates S/HOOK-RAN) and a skill: the rule and instruction files reach the session, and the hook runs on the first tool use (S/HOOK-RAN exists only after a prompt that uses a tool)", async (run) => {
  const cwd = join(run.work, "cwd");
  run.place("work", "cwd/notes.txt", "hello notes\n");
  const S = join(run.work, "S");
  run.place("work", "S/AGENTS.md", markerLine("MARKER-SAGENTS"));
  run.place("work", "S/GEMINI.md", markerLine("MARKER-SGEMINI"));
  run.place("work", "S/.agents/rules/r.md", `---\ntrigger: always_on\n---\n${markerLine("MARKER-SRULE")}`);
  run.place("work", "S/.agents/hooks.json", hookJson(join(S, "HOOK-RAN")));
  run.placeSkill("work", "S/.agents/skills", "h1293-sskill", "SSKILL");
  const done = run.watch({ cwd, S, fakeHome: run.fakeHome, TMPDIR: run.tmp });
  const agy = run.start({ cwd });
  const session = await agy.newSession({ cwd, additionalDirectories: [S] });
  run.observed.skillsListed = names(testSkills(session.commands));
  const hookRan = () => run.readText(join(S, "HOOK-RAN"));
  run.observed.hookFileBeforeAnyPrompt = hookRan();
  await run.ask(agy, session.sessionId, MARKER_PROMPT, 60_000);
  run.observed.hookFileAfterMarkerPrompt = hookRan();
  await run.ask(agy, session.sessionId, READ_PROMPT(join(cwd, "notes.txt")));
  run.observed.hookFileAfterPromptThatReadsAFile = hookRan();
  await agy.close();
  done();
});
