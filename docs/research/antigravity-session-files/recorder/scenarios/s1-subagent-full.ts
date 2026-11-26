import { prompt, summarize, autoPermission, sleep, isUpdate, FULL_ACCESS } from "../agy-session.ts";
import { run1283, quotaHit } from "../lib1283.ts";
await run1283("subagent-full", { flags: FULL_ACCESS }, async (agy, ctx) => {
  autoPermission(agy);
  const r = await prompt(agy, ctx.sessionId, "Use invoke_subagent to start one subagent with the Role 'File Writer'. Its task: run the shell command `echo SUBMARK > sub.txt`, then report back to you. When it has reported back, reply with the single word DONE.");
  agy.note("prompt replied; keeping agy running 30s");
  await sleep(30_000);
  return `${summarize("subagent-full", r)} quota=${quotaHit(agy)}`;
});
