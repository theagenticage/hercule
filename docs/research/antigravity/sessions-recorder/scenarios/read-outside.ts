import { startAgy, openSession, prompt, sleep, freshWork } from "../agy-session.ts";
import { writeFileSync } from "node:fs";
const [home, outDir] = process.argv.slice(2);
const cwd = freshWork("read-outside");
writeFileSync(cwd + "/../parent-secret.txt", "pineapple banana\n");
const agy = startAgy({ home, cwd, out: `${outDir}/read-outside.jsonl` });
const perms: string[] = [];
agy.onRequest((m) => { if (m.method === "session/request_permission") { perms.push(JSON.stringify(m.params).slice(0, 300)); agy.respond(m.id, { outcome: { outcome: "selected", optionId: (m.params.options.find((o: any) => o.kind === "allow_once") ?? m.params.options[0]).optionId } }); } else agy.respond(m.id, { action: "decline" }); });
const { sessionId } = await openSession(agy, { cwd });
for (const q of ["Read the file /etc/hostname and tell me its first word.", `Read the file ${cwd}/../parent-secret.txt and tell me its first word.`]) {
  const before = perms.length;
  const r = await prompt(agy, sessionId, q);
  const tools = agy.messages.filter((m) => m.method === "session/update" && ["tool_call"].includes(m.params?.update?.sessionUpdate)).map((m) => `${m.params.update.kind}:${m.params.update.title}`).slice(-3);
  console.log(q.slice(0, 40), "=>", r.result?.stopReason ?? JSON.stringify(r.error), "permissions asked:", perms.length - before, perms.slice(before), "tools:", tools);
}
await agy.close(); process.exit(0);
