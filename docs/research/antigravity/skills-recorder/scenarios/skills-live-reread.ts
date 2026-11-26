// agy reads the Harness Home's skill places and instruction files again at each prompt.
import { join } from "node:path";
import { markerLine, names, runScenario, testSkills } from "../driver.ts";

const LIST_PROMPT = "Do not use any tools. From the instructions and skill list already in your context only, list every token starting with MARKER- and every skill name starting with h1293-, one per line, nothing else.";

await runScenario("skills-live-reread", "files staged in the Harness Home after session/new and before the first prompt (a skill in antigravity-acp/skills, a GEMINI.md, config/skills.json pointing at a folder with another skill) are seen at the next prompt, and removing them makes the next prompt lose them; no second available_commands_update is sent when skills change", async (run) => {
  const cwd = join(run.work, "cwd");
  run.mkdir("work", "cwd");
  run.place("work", "cwd/AGENTS.md", markerLine("MARKER-CWD"));
  const done = run.watch({ cwd, fakeHome: run.fakeHome, TMPDIR: run.tmp });
  const agy = run.start({ cwd });
  const session = await agy.newSession({ cwd });
  const updatesAtStart = session.commandUpdates;
  run.observed.skillsListedAtSessionNew = names(testSkills(session.commands));
  const updatesBeforeStaging = agy.commandUpdateCount();

  // Stage three things in the Harness Home after the session exists.
  run.placeSkill("home", "antigravity-acp/skills", "h1293-late", "LATE");
  run.place("home", "GEMINI.md", markerLine("MARKER-LATEHOME"));
  run.placeSkill("work", "listed-by-config-skills-json", "h1293-latejson", "LATEJSON");
  run.place("home", "config/skills.json", JSON.stringify({ entries: [{ path: join(run.work, "listed-by-config-skills-json") }] }) + "\n");
  await run.ask(agy, session.sessionId, LIST_PROMPT, 60_000, { step: "after staging: list" });
  await run.ask(agy, session.sessionId, "/h1293-late x", 90_000, { step: "after staging: run the skill of antigravity-acp/skills" });
  await run.ask(agy, session.sessionId, "/h1293-latejson x", 90_000, { step: "after staging: run the skill of config/skills.json" });

  // Remove them again, and ask once more.
  run.removeStagedHomeFiles();
  await run.ask(agy, session.sessionId, LIST_PROMPT, 60_000, { step: "after removal: list" });
  await run.ask(agy, session.sessionId, "/h1293-late x", 60_000, { step: "after removal: run the removed skill" });
  await agy.close();
  done();
  run.observed.commandUpdatesAtSessionNew = updatesAtStart;
  run.observed.commandUpdatesAfterStaging = agy.commandUpdateCount() - updatesBeforeStaging;
});

