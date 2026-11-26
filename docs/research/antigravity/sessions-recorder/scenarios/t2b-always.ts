import { setup, cleanup, handle, startAgy, openSession, prompt, freshWork, HOME, OUT } from "./trust-lib.ts";
const tmp = setup(); const cwd = freshWork("t2b");
const agy = startAgy({ home: HOME, cwd, out: `${OUT}/t2b-always.jsonl` });
try {
  const reqs: any[] = [];
  agy.onRequest((m) => { if (m.method === "session/request_permission") { reqs.push(m.params.options.map((o: any) => o.kind + ":" + o.name)); const o = m.params.options.find((x: any) => x.kind === "allow_always") ?? m.params.options[0]; agy.respond(m.id, { outcome: { outcome: "selected", optionId: o.optionId } }); } else agy.respond(m.id, { action: "decline" }); });
  const { sessionId } = await openSession(agy, { cwd });
  let r = await prompt(agy, sessionId, "Run the command `echo hi` and reply done."); console.log(r.result?.stopReason, JSON.stringify(reqs));
  const n = reqs.length;
  r = await prompt(agy, sessionId, "Run the command `echo hi` again and reply done."); console.log("2nd asks:", reqs.length - n);
} finally { await agy.close(); cleanup(tmp); }
