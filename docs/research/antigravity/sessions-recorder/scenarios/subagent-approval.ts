import { runScenario, openSession, prompt, summarize, autoPermission, select, sleep, setMode, isUpdate, FULL_ACCESS, text } from "../agy-session.ts";
await runScenario("subagent-approval", {}, {}, async (agy, ctx) => {
  const { sessionId } = await openSession(agy, { cwd: ctx.cwd });
  let requests = 0;
  agy.onRequest((m) => {
    if (m.method === "session/request_permission") { requests++; select(agy, m, "allow_once"); }
    else agy.respond(m.id, { action: "decline" });
  });
  const reply = prompt(agy, sessionId, "Use a subagent to create a file sub.txt containing the text hi. Say DONE when it is finished.");
  await sleep(120_000);
  const r = await Promise.race([reply, sleep(1).then(() => undefined)]);
  return `subagent-approval: ${r ? summarize("p", r) : "prompt still open after 120s"}; permission requests that reached us=${requests}`;
});
