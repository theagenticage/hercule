// The folder agy's process starts in counts like a working folder, for every session of that process.
import { join } from "node:path";
import { names, runScenario, testSkills } from "../driver.ts";

await runScenario("skills-process-folder", "the folder agy is started in counts like a working folder: its .agents/skills reaches every session of that process, also sessions whose working folder is elsewhere (this recording starts agy in a folder other than the session's, on purpose; every other recording starts it in the session's working folder)", async (run) => {
  const spawnCwd = join(run.work, "spawn");
  const folderA = join(run.work, "a");
  const folderB = join(run.work, "b");
  run.placeSkill("work", "spawn/.agents/skills", "h1293-spawn", "SPAWNSK");
  run.placeSkill("work", "a/.agents/skills", "h1293-a", "FOLDERA");
  run.mkdir("work", "b");
  const done = run.watch({ spawn: spawnCwd, a: folderA, b: folderB, fakeHome: run.fakeHome, TMPDIR: run.tmp });
  const agy = run.start({ cwd: spawnCwd });
  const sessions: Record<string, unknown> = {};
  for (const [label, cwd] of [["sessionInFolderA", folderA], ["sessionInFolderB", folderB]] as const) {
    const s = await agy.newSession({ cwd });
    sessions[label] = { cwd: cwd.replace(run.work, "<work>"), skillsListed: names(testSkills(s.commands)) };
    console.log(label, names(testSkills(s.commands)).join());
  }
  await agy.close();
  done();
  run.observed.processStartedIn = "<work>/spawn";
  run.observed.sessions = sessions;
});
