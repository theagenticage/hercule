import { runScenario, openSession, prompt, summarize, autoPermission, select, sleep, setMode, isUpdate, FULL_ACCESS, text } from "../agy-session.ts";
await runScenario("background-command", {}, { extraFlags: FULL_ACCESS }, async (agy, ctx) => {
  const { sessionId } = await openSession(agy, { cwd: ctx.cwd });
  autoPermission(agy);
  const r = await prompt(agy, sessionId, "Run the command `sleep 20; echo finished` in the background (do not wait for it), then end your turn right away by saying only STARTED.");
  agy.note("prompt replied; reading for 40s with no prompt open");
  const after = agy.messages.length;
  await sleep(40_000);
  return `${summarize("background-command", r)}; messages after reply: ${agy.messages.length - after}`;
});
