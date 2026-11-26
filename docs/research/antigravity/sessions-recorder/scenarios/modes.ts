import { runScenario, openSession, prompt, summarize, autoPermission, select, sleep, setMode, isUpdate, FULL_ACCESS, text } from "../agy-session.ts";
await runScenario("modes", {}, {}, async (agy, ctx) => {
  const { sessionId, session } = await openSession(agy, { cwd: ctx.cwd });
  autoPermission(agy);
  const offered: string[] = (session.result.modes?.availableModes ?? []).map((m: any) => m.id);
  const lines: string[] = [];
  for (const modeId of ["accept-edits", "plan", "auto"]) {
    if (!offered.includes(modeId)) { lines.push(`${modeId}: not offered`); agy.note(`mode ${modeId} not offered`); continue; }
    const start = agy.messages.length;
    const reply = await setMode(agy, sessionId, modeId);
    const update = await agy.waitFor(isUpdate("current_mode_update"), 5000, start).then(() => "update", () => "no update in 5s");
    lines.push(`${modeId}: ${reply.error ? "error" : "ok"}, ${update}`);
  }
  await setMode(agy, sessionId, "default");
  await sleep(1000);
  agy.note("back in default; prompting /plan");
  const start = agy.messages.length;
  const r = await prompt(agy, sessionId, "/plan");
  const changed = agy.messages.slice(start).some(isUpdate("current_mode_update"));
  return `modes: ${lines.join("; ")}; /plan -> ${summarize("p", r)}, mode change seen=${changed}`;
});
