// What agy stores for a typed /<skill> and for a prompt that names $<skill>.
import { join } from "node:path";
import { runScenario } from "../driver.ts";

await runScenario("skills-slash-note", "a typed /<name> args is stored as typed inside <USER_REQUEST> and agy adds a note in <ADDITIONAL_METADATA> with the path of the skill file it picked (no skill text); a prompt with $<name> in it is stored as typed with no such note", async (run) => {
  const cwd = join(run.work, "cwd");
  run.mkdir("work", "cwd");
  run.placeSkill("work", "cwd/.agents/skills", "h1293-cwd", "CWDSK");
  const S = run.stageSessionSkills("S", { lib: [["h1293-lib", "LIBSK"]], gitFile: true });
  const done = run.watch({ cwd, S, fakeHome: run.fakeHome, TMPDIR: run.tmp });
  const agy = run.start({ cwd });
  const session = await agy.newSession({ cwd, additionalDirectories: [S] });
  const prompts = ["/h1293-lib hello", "Please use $h1293-lib now", "/h1293-cwd hello"];
  for (const p of prompts) await run.ask(agy, session.sessionId, p);
  await agy.close();
  done();
  // The stored transcript of this session: the lines that hold a user request, with the notes agy added.
  run.observed.storedUserRequests = run.userRequestLines(session.sessionId);
});
