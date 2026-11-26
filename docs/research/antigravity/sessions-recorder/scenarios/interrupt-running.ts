import { runScenario, openSession, prompt, summarize, autoPermission, select, sleep, setMode, isUpdate, FULL_ACCESS, text } from "../agy-session.ts";
await runScenario("interrupt-running", {}, { extraFlags: FULL_ACCESS }, async (agy, ctx) => {
  const { sessionId } = await openSession(agy, { cwd: ctx.cwd });
  autoPermission(agy);
  const start = agy.messages.length;
  const reply = prompt(agy, sessionId, "Run the command `sleep 30 && echo done` and report its output.");
  await agy.waitFor(isUpdate("tool_call"), 120_000, start);
  agy.note("tool_call arrived; sending session/cancel");
  agy.notify("session/cancel", { sessionId });
  const r = await Promise.race([reply, sleep(60_000).then(() => undefined)]);
  agy.note("prompt replied or 60s passed; waiting 5s more");
  await sleep(5000);
  return r ? summarize("interrupt-running", r) : "interrupt-running: no reply to the prompt within 60s of cancel";
});
