// Which copy of a skill wins when several places hold the same name. One session, one listing, one slash command.
import { join } from "node:path";
import { names, runScenario, testSkills } from "../driver.ts";

await runScenario("skills-precedence", "the winner when the same skill name is in several places (the winner is the copy whose marker word is in the one listed description): .agent/skills beats .agents/skills of one folder; the git root beats a sub folder (working folder in the sub folder); the workspace beats the Harness Home; an additional directory beats the workspace; inside the Harness Home antigravity-acp/skills beats config/skills beats skills; a skill named like the built-in grill-me is listed beside the built-in, not instead of it", async (run) => {
  const repo = join(run.work, "repo");
  const cwd = join(repo, "sub");
  run.gitInit("work", "repo");
  run.mkdir("work", "repo/sub");
  // 1. .agent/skills against .agents/skills in the working folder.
  run.placeSkill("work", "repo/sub/.agent/skills", "h1293-dup-agent", "AGENTSINGULAR");
  run.placeSkill("work", "repo/sub/.agents/skills", "h1293-dup-agent", "AGENTSPLURAL");
  // 2. The git root against the sub folder.
  run.placeSkill("work", "repo/.agents/skills", "h1293-dup-root", "GITROOTCOPY");
  run.placeSkill("work", "repo/sub/.agents/skills", "h1293-dup-root", "SUBFOLDERCOPY");
  // 3. The workspace against the Harness Home.
  run.placeSkill("work", "repo/sub/.agents/skills", "h1293-dup-home", "WORKSPACECOPY");
  run.placeSkill("home", "config/skills", "h1293-dup-home", "HOMECONFIGCOPY");
  // 4. Inside the Harness Home only.
  run.placeSkill("home", "antigravity-acp/skills", "h1293-dup-homes", "HOMEAPPCOPY");
  run.placeSkill("home", "config/skills", "h1293-dup-homes", "HOMECONFIGCOPY2");
  run.placeSkill("home", "skills", "h1293-dup-homes", "HOMEROOTCOPY");
  // 5. An additional directory against the workspace (and the one the slash command runs).
  run.placeSkill("work", "repo/sub/.agents/skills", "h1293-dup", "WORKSPACECOPY2");
  const S = run.stageSessionSkills("S", { lib: [["h1293-dup", "ADDITIONALDIRCOPY"]], gitFile: true });
  // 6. A skill named like a built-in.
  run.placeSkill("work", "repo/sub/.agents/skills", "grill-me", "BUILTINNAME");

  const done = run.watch({ cwd: repo, S, fakeHome: run.fakeHome, TMPDIR: run.tmp });
  const agy = run.start({ cwd });
  const session = await agy.newSession({ cwd, additionalDirectories: [S] });
  const listed = testSkills(session.commands);
  const byName: Record<string, string[]> = {};
  for (const c of listed) (byName[c.name] ??= []).push(c.description);
  run.observed.entriesListedPerName = byName;
  run.observed.commandUpdates = session.commandUpdates;
  const r = await agy.prompt(session.sessionId, "/h1293-dup x", 90_000);
  run.observed.slashDup = { prompt: "/h1293-dup x", reply: r.text, stopReason: r.stopReason, permissionRequests: r.permissionRequests };
  await agy.close();
  done();
  console.log(JSON.stringify(byName, null, 1));
  console.log("slash:", r.text, r.permissionRequests.length);
  console.log(names(listed).join());
});
