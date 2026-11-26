import { runScenario, openSession, prompt, summarize, autoPermission, select, sleep, setMode, isUpdate, FULL_ACCESS, text } from "../agy-session.ts";
await runScenario("two-requests", {}, {}, async (agy, ctx) => {
  const { sessionId } = await openSession(agy, { cwd: ctx.cwd });
  let count = 0;
  let maxOpen = 0;
  let open = 0;
  agy.onRequest(async (m) => {
    if (m.method !== "session/request_permission") return agy.respond(m.id, { action: "decline" });
    count++;
    open++;
    maxOpen = Math.max(maxOpen, open);
    if (count === 1) await sleep(5000);
    select(agy, m, "allow_once");
    open--;
  });
  const r = await prompt(agy, sessionId, "Run these two commands in parallel: `echo a > a.txt` and `echo b > b.txt`");
  return `${summarize("two-requests", r)}; permission requests=${count}, max open at once=${maxOpen}`;
});
