import { runScenario, openSession, prompt, summarize, autoPermission, select, sleep, setMode, isUpdate, FULL_ACCESS, text } from "../agy-session.ts";
await runScenario("nonzero-exit", {}, { extraFlags: FULL_ACCESS }, async (agy, ctx) => {
  const { sessionId } = await openSession(agy, { cwd: ctx.cwd });
  autoPermission(agy);
  const r = await prompt(agy, sessionId, "Run the command `ls /does-not-exist` and report what happened in one sentence.");
  return summarize("nonzero-exit", r);
});
