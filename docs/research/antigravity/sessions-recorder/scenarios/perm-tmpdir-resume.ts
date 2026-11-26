import { runScenario, openSession, prompt, summarize, autoPermission, startAgy, sleep } from "../agy-session.ts";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
await runScenario("tmpdir-resume", { "notes.txt": "x\n" }, {}, async (agy, ctx) => {
  const A = mkdtempSync("/tmp/hercule-agy-"); process.env.TMPDIR = A;
  // agy was already started by runScenario with the env at that time; restart explicitly with TMPDIR A.
  await agy.close();
  const a1 = startAgy({ home: ctx.home, cwd: ctx.cwd, out: ctx.out, append: true });
  a1.note(`process 1 TMPDIR=${A}`);
  autoPermission(a1);
  const s = await openSession(a1, { cwd: ctx.cwd });
  const r1 = await prompt(a1, s.sessionId, `Remember the number 4817. Write the text 4817 to the file ${A}/num.txt. Reply OK.`);
  await a1.close();
  rmSync(A, { recursive: true, force: true });
  const B = mkdtempSync("/tmp/hercule-agy-"); process.env.TMPDIR = B;
  const b = startAgy({ home: ctx.home, cwd: ctx.cwd, out: ctx.out, append: true });
  let line: string;
  try {
    b.note(`process 2 TMPDIR=${B} (A removed: ${A})`);
    autoPermission(b);
    const o = await openSession(b, { cwd: ctx.cwd, resumeId: s.sessionId });
    const r2 = await prompt(b, o.sessionId, "What number did I ask you to remember? Answer with just the number.");
    const txt = b.messages.filter((m) => m.params?.update?.sessionUpdate === "agent_message_chunk").map((m) => m.params.update.content.text).join("");
    line = `${summarize("p1", r1)}; ${summarize("p2", r2)}; reply=${JSON.stringify(txt)}`;
  } finally { await b.close(); rmSync(B, { recursive: true, force: true }); }
  return line;
});
