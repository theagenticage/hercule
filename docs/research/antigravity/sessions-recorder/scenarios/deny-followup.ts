import { runScenario, openSession, prompt, summarize, autoPermission, select, sleep, setMode, isUpdate, FULL_ACCESS, text } from "../agy-session.ts";
await runScenario("deny-followup", {}, {}, async (agy, ctx) => {
  const { sessionId } = await openSession(agy, { cwd: ctx.cwd });
  autoPermission(agy, "reject_once");
  const r1 = await prompt(agy, sessionId, "Run the command `touch denied.txt` and then say DONE.");
  agy.note("first prompt replied; sending follow-up");
  const r2 = await prompt(agy, sessionId, "The user denied your last tool call (run_command). Do not run it again or work around it. Go on without it, or say what you need.");
  return `${summarize("deny-followup prompt1", r1)}; ${summarize("prompt2", r2)}`;
});
