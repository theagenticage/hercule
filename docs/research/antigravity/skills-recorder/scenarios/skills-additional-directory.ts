// A session skills folder S passed as an additional directory, in the layout the adapter builds.
import { join } from "node:path";
import { names, runScenario, skillMd, testSkills } from "../driver.ts";

await runScenario("skills-additional-directory", "additionalDirectories on session/new loads <dir>/.agents/skills for that session only (a second session/new of the same process without the field does not list them), and a skill reached through a link inside the folder, through a link into the workspace checkout and through a link to a place outside both runs with the permission requests recorded; --add-dir on a second process lists them for every session of that process; --include-default-customizations=false changes nothing; a skill folder not under .agents/skills does not load", async (run) => {
  const cwd = join(run.work, "cwd");
  run.mkdir("work", "cwd");
  // The checkout inside the workspace holds a repository skill under .claude/skills (agy loads that place only through the link).
  run.gitInit("work", "cwd/co");
  run.placeSkill("work", "cwd/co/.claude/skills", "h1293-rs", "REPOSK");
  // A skill outside the folder and outside the workspace, reached through a link.
  run.placeSkill("work", "outside/skills", "h1293-out", "OUTSIDESK");
  const S = run.stageSessionSkills("S", {
    lib: [["h1293-lib", "LIBSK"]],
    repo: [{ checkout: "co", name: "h1293-rs", target: join(cwd, "co/.claude/skills/h1293-rs") }],
    gitFile: true,
  });
  run.link("work", "S/.agents/skills/h1293-out", "../../../outside/skills/h1293-out");
  // Folders of skills that are not under .agents/skills.
  run.place("work", "S/skills/h1293-notlinked/SKILL.md", skillMd("h1293-notlinked", "NOTLINKED"));
  run.place("work", "S/h1293-direct/SKILL.md", skillMd("h1293-direct", "DIRECT"));

  const done = run.watch({ cwd, S, outside: join(run.work, "outside"), fakeHome: run.fakeHome, TMPDIR: run.tmp });
  const lists: Record<string, unknown> = {};
  const record = (label: string, commands: Array<{ name: string; description: string }>, extra: Record<string, unknown> = {}) => {
    lists[label] = { skillsListed: names(testSkills(commands)), ...extra };
    console.log(label, names(testSkills(commands)).join());
  };

  // Process 1: the field on the first session/new, none on the second.
  let agy = run.start({ cwd });
  const first = await agy.newSession({ cwd, additionalDirectories: [S] });
  record("process1_session1_withAdditionalDirectories", first.commands, { sessionId: first.sessionId, commandUpdates: first.commandUpdates });
  for (const p of ["/h1293-lib x", "/h1293-rs x", "/h1293-out x"]) await run.ask(agy, first.sessionId, p, 90_000, { mode: "default", session: "process1_session1" });
  const second = await agy.newSession({ cwd });
  record("process1_session2_withoutTheField", second.commands, { sessionId: second.sessionId });
  await agy.close();

  // Process 2: the flag. Two sessions, neither passes the field.
  agy = run.start({ cwd, flags: ["--add-dir", S] });
  const f1 = await agy.newSession({ cwd });
  record("process2_addDirFlag_session1", f1.commands, { sessionId: f1.sessionId });
  const f2 = await agy.newSession({ cwd });
  record("process2_addDirFlag_session2", f2.commands, { sessionId: f2.sessionId });
  await agy.close();

  // Process 3: the flag, and --include-default-customizations=false.
  agy = run.start({ cwd, flags: ["--add-dir", S, "--include-default-customizations=false"] });
  const g1 = await agy.newSession({ cwd });
  record("process3_addDirFlag_includeDefaultCustomizationsFalse", g1.commands, { sessionId: g1.sessionId });
  await agy.close();
  run.observed.sameListAsProcess2WithoutTheOption = JSON.stringify(g1.commands) === JSON.stringify(f1.commands);
  done();
  run.observed.lists = lists;
});
