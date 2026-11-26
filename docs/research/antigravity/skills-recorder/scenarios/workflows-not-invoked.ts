// Workflow files are neither listed as commands nor run by name.
import { join } from "node:path";
import { names, runScenario, testSkills } from "../driver.ts";

await runScenario("workflows-not-invoked", "workflow files in <home>/config/global_workflows, <home>/config/workflows and <cwd>/.agents/workflows are not in available_commands_update, and a slash prompt with each name is stored as plain text, with no note and no workflow body; the model does not know the command", async (run) => {
  const cwd = join(run.work, "cwd");
  run.mkdir("work", "cwd");
  const workflow = (tag: string) => `---\ndescription: Test workflow ${tag}.\n---\nReply with exactly one line: WF-${tag}-RAN\n`;
  run.place("home", "config/global_workflows/h1293-wfa.md", workflow("A"));
  run.place("home", "config/workflows/h1293-wfb.md", workflow("B"));
  run.place("work", "cwd/.agents/workflows/h1293-wfc.md", workflow("C"));
  const done = run.watch({ cwd, fakeHome: run.fakeHome, TMPDIR: run.tmp });
  const agy = run.start({ cwd });
  const session = await agy.newSession({ cwd, mode: "default" });
  const all = names(session.commands);
  run.observed.commandNamesListed = all;
  run.observed.anyWorkflowListed = all.some((n) => n.startsWith("h1293-wf"));
  run.observed.h1293SkillsListed = names(testSkills(session.commands));
  for (const p of ["/h1293-wfa", "/h1293-wfb", "/h1293-wfc"]) await run.ask(agy, session.sessionId, p, 60_000);
  await agy.close();
  done();
  run.observed.storedUserRequests = run.userRequestLines(session.sessionId);
  run.observed.workflowMarkerInTranscript = JSON.stringify(run.transcript(session.sessionId)).includes("WF-A-RAN") || JSON.stringify(run.transcript(session.sessionId)).includes("WF-C-RAN");
});
