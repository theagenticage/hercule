import { runScenario, openSession, prompt, summarize, autoPermission, setMode, FULL_ACCESS, sleep } from "../agy-session.ts";
import { readFileSync, writeFileSync } from "node:fs";
// env: NAME, PROMPT, MODE (default|accept-edits), FULL=1, FS=1 (fs capability), FILES (json)
const name = process.env.NAME!;
const files = JSON.parse(process.env.FILES ?? '{"notes.txt":"Shopping list: milk, eggs.\\n"}');
await runScenario(name, files, { extraFlags: process.env.FULL ? FULL_ACCESS : [] }, async (agy, ctx) => {
  const caps = process.env.FS
    ? { fs: { readTextFile: true, writeTextFile: true }, terminal: false, elicitation: { form: {} } }
    : undefined;
  const { sessionId } = await openSession(agy, { cwd: ctx.cwd, clientCapabilities: caps });
  if (process.env.MODE && process.env.MODE !== "default") { const r = await setMode(agy, sessionId, process.env.MODE); agy.note(`set_mode ${process.env.MODE}: ${JSON.stringify(r.result ?? r.error)}`); }
  const perms: string[] = [];
  agy.onRequest((m) => {
    if (m.method === "fs/write_text_file") {
      writeFileSync(m.params.path, m.params.content); agy.respond(m.id, {});
    } else if (m.method === "fs/read_text_file") {
      let content = ""; try { content = readFileSync(m.params.path, "utf8"); } catch {}
      agy.respond(m.id, { content });
    } else if (m.method === "session/request_permission") {
      perms.push(m.params.toolCall?.name);
      const o = (m.params.options ?? []).find((x: any) => x.kind === "allow_once") ?? m.params.options[0];
      agy.respond(m.id, { outcome: { outcome: "selected", optionId: o.optionId } });
    }
  });
  // fs handlers (the recorder answers unknown agent requests with -32601, so patch via onRequest isn't enough)
  const r = await prompt(agy, sessionId, process.env.PROMPT!);
  return `${summarize(name, r)}; permission requests for: ${JSON.stringify(perms)}`;
});
