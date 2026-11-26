import { runScenario, openSession, prompt, summarize, autoPermission, select, sleep, setMode, isUpdate, FULL_ACCESS, text } from "../agy-session.ts";
await runScenario("cancel-during-permission", {}, {}, async (agy, ctx) => {
  const { sessionId } = await openSession(agy, { cwd: ctx.cwd });
  let held: any;
  agy.onRequest((m) => {
    if (m.method === "session/request_permission") held = m;
    else agy.respond(m.id, { action: "decline" });
  });
  const start = agy.messages.length;
  const reply = prompt(agy, sessionId, "Run the command `echo hi > hi.txt` and then say DONE.");
  let answered = false;
  void reply.then(() => { agy.note("prompt replied"); });
  await agy.waitFor((m) => m.method === "session/request_permission", 120_000, start);
  agy.note("permission request arrived; sending session/cancel without answering");
  agy.notify("session/cancel", { sessionId });
  await sleep(3000);
  agy.note("answering the request cancelled");
  agy.respond(held.id, { outcome: { outcome: "cancelled" } });
  answered = true;
  await sleep(5000);
  const settled = await Promise.race([reply, sleep(1).then(() => undefined)]);
  return settled ? summarize("cancel-during-permission", settled) : `cancel-during-permission: prompt still open after ${answered ? "answer + 5s" : ""}`;
});
