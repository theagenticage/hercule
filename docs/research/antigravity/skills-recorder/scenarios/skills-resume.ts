// session/resume with a new session skills folder, and with none.
import { join } from "node:path";
import { READ_PROMPT, names, runScenario, testSkills } from "../driver.ts";

await runScenario("skills-resume", "session/resume takes additionalDirectories again and the field replaces the set: with a new folder only the new folder's skills are listed, with no field none are; the skill of the earlier folder still runs right after the resume from the conversation's history; reading a file of the earlier folder by its absolute path is (or is not) asked", async (run) => {
  const cwd = join(run.work, "cwd");
  run.mkdir("work", "cwd");
  const S1 = run.stageSessionSkills("S1", { lib: [["h1293-old", "OLDSK"]], gitFile: true });
  run.place("work", "S1/notes.txt", "S1-NOTES-LINE\n");
  const S2 = run.stageSessionSkills("S2", { lib: [["h1293-resumed", "RESUMEDSK"]], gitFile: true });
  const done = run.watch({ cwd, S1, S2, fakeHome: run.fakeHome, TMPDIR: run.tmp });
  const lists: Record<string, unknown> = {};
  const record = (label: string, c: Array<{ name: string; description: string }>, extra: Record<string, unknown> = {}) => {
    lists[label] = { skillsListed: names(testSkills(c)), ...extra };
    console.log(label, names(testSkills(c)).join());
  };

  // Process 1: a new session with S1 and one prompt. Then the process ends.
  let agy = run.start({ cwd });
  const s = await agy.newSession({ cwd, additionalDirectories: [S1] });
  record("process1_new_withS1", s.commands, { sessionId: s.sessionId });
  await run.ask(agy, s.sessionId, "/h1293-old x");
  await agy.close();

  // Process 2: resume with S2 only.
  agy = run.start({ cwd });
  const r = await agy.resumeSession(s.sessionId, { cwd, additionalDirectories: [S2] });
  record("process2_resume_withS2", r.commands, { commandUpdates: r.commandUpdates });
  await run.ask(agy, r.sessionId, "/h1293-resumed x", 90_000, { step: "skill of the new folder" });
  await run.ask(agy, r.sessionId, "/h1293-old x", 90_000, { step: "skill of the earlier folder, not listed any more" });
  await run.ask(agy, r.sessionId, READ_PROMPT(join(S1, "notes.txt")), 90_000, { step: "a file of the earlier folder by its absolute path" });
  await agy.close();

  // Process 3: resume with no field.
  agy = run.start({ cwd });
  const n = await agy.resumeSession(s.sessionId, { cwd });
  record("process3_resume_withoutTheField", n.commands, { commandUpdates: n.commandUpdates });
  await agy.close();
  done();
  run.observed.lists = lists;
});
