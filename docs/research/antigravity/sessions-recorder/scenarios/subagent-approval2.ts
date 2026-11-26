import { runScenario, openSession, prompt, summarize, autoPermission, select, sleep, setMode, isUpdate, FULL_ACCESS, text } from "../agy-session.ts";
await runScenario("subagent-approval2", {}, {}, async (agy, ctx) => {
  const { sessionId } = await openSession(agy, { cwd: ctx.cwd });
  let requests = 0;
  agy.onRequest((m) => {
    if (m.method === "session/request_permission") { requests++; select(agy, m, "allow_once"); }
    else agy.respond(m.id, { action: "decline" });
  });
  const reply = prompt(agy, sessionId, "Use a subagent for this: the subagent must run the shell command `echo hi > sub.txt` with its command tool, and then write a second file sub2.txt containing the text hi with its file tool. Say DONE when it is finished.");
  await sleep(120_000);
  const r = await Promise.race([reply, sleep(1).then(() => undefined)]);
  return `subagent-approval2: ${r ? summarize("p", r) : "prompt still open after 120s"}; permission requests that reached us=${requests}`;
});
