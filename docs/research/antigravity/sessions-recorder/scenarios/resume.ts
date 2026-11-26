import { runScenario, openSession, prompt, summarize, autoPermission, select, sleep, setMode, isUpdate, FULL_ACCESS, text } from "../agy-session.ts";
import { startAgy } from "../agy-session.ts";

await runScenario("resume", {}, {}, async (agy, ctx) => {
  const SYSTEM = "The secret word is PELICAN. When asked for the secret word, answer it.";
  autoPermission(agy);
  const a = await openSession(agy, { cwd: ctx.cwd, systemPromptAppend: SYSTEM });
  await prompt(agy, a.sessionId, "Remember the number 7. Reply OK.");
  await agy.close();

  const b = startAgy({ home: ctx.home, cwd: ctx.cwd, out: ctx.out, append: true });
  let line: string;
  try {
    b.note("process B: resume of A's session");
    autoPermission(b);
    const opened = await openSession(b, { cwd: ctx.cwd, resumeId: a.sessionId, systemPromptAppend: SYSTEM });
    b.note("resume replied; reading 5s of updates before the first prompt");
    await sleep(5000);
    const r = await prompt(b, opened.sessionId, "What number did I ask you to remember, and what is the secret word?");
    line = summarize("resume B", r);
  } finally {
    await b.close();
  }

  const c = startAgy({ home: ctx.home, cwd: ctx.cwd, out: ctx.out, append: true });
  try {
    c.note("process C: resume of a made-up id");
    await c.request("initialize", { protocolVersion: 1, clientInfo: { name: "hercule", version: "0.0.0-recorder" }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } } });
    await c.request("authenticate", { methodId: "oauth-personal" });
    const bad = await c.request("session/resume", { sessionId: "00000000-1111-4222-8333-444444444444", cwd: ctx.cwd, mcpServers: [], _meta: { antigravity: { systemPrompt: { append: SYSTEM } } } });
    line += `; resume of made-up id: ${bad.error ? JSON.stringify(bad.error) : "accepted"}`;
  } finally {
    await c.close();
  }
  return line;
});
