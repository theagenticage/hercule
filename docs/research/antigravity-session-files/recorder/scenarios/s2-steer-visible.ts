import { prompt, summarize, autoPermission, sleep, isUpdate, FULL_ACCESS } from "../agy-session.ts";
import { run1283, quotaHit } from "../lib1283.ts";
await run1283("steer-visible", { flags: FULL_ACCESS }, async (agy, ctx) => {
  autoPermission(agy);
  const start = agy.messages.length;
  let r1: any, r2: any;
  const p1 = prompt(agy, ctx.sessionId, "Run the shell command `sleep 12`, then reply with the single word ALPHA.").then((m) => { r1 = m; agy.note(`PROMPT1 REPLIED ${JSON.stringify(m)}`); });
  await agy.waitFor(isUpdate("tool_call"), 120_000, start);
  agy.note("first tool_call arrived; waiting 2s, then sending prompt 2");
  await sleep(2000);
  agy.note("sending prompt 2");
  const p2 = prompt(agy, ctx.sessionId, "Also, at the very end of your reply, add the single word BRAVO.").then((m) => { r2 = m; agy.note(`PROMPT2 REPLIED ${JSON.stringify(m)}`); });
  await Promise.race([Promise.all([p1, p2]), sleep(120_000)]);
  agy.note(`end of wait; r1=${Boolean(r1)} r2=${Boolean(r2)}; 5s more`);
  await sleep(5000);
  return `${r1 ? summarize("p1", r1) : "p1 no reply"}; ${r2 ? summarize("p2", r2) : "p2 no reply in 120s"} quota=${quotaHit(agy)}`;
});
