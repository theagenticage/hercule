// How often agy sends available_commands_update after session/new, with and without a model switch right after it.
import { join } from "node:path";
import { names, runScenario } from "../driver.ts";

await runScenario("skills-command-updates", "how many available_commands_update messages one session/new produces: the model is set right after the session opens (as the adapter does), not set at all, and set 4 seconds later", async (run) => {
  const cwd = join(run.work, "cwd");
  run.mkdir("work", "cwd");
  run.placeSkill("work", "cwd/.agents/skills", "h1293-cwd", "CWD");
  const done = run.watch({ cwd, fakeHome: run.fakeHome, TMPDIR: run.tmp });
  const agy = run.start({ cwd });
  const results: Record<string, unknown> = {};
  const a = await agy.newSession({ cwd });
  results.modelSetRightAfterNew = { sessionId: a.sessionId, commandUpdates: a.commandUpdates, names: names(a.commands) };
  const b = await agy.newSession({ cwd, model: false });
  results.modelNeverSet = { sessionId: b.sessionId, commandUpdates: b.commandUpdates, names: names(b.commands) };
  await agy.close();
  done();
  run.observed.updatesPerSession = results;
  console.log(JSON.stringify(results, (k, v) => (k === "names" ? undefined : v)));
});
