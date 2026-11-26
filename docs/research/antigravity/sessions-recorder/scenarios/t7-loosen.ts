import { writeFileSync, rmSync, readFileSync } from "node:fs";
import { setup, cleanup, handle, startNoted, openSession, prompt, freshWork, HOME, toolNames } from "./trust-lib.ts";
const [value] = process.argv.slice(2);
const OUT5 = "/tmp/hercule-1282/rec5";
const tmp = setup(); const cwd = freshWork(`t7-${value}`, { "notes.txt": "milk\n" });
const set = `${HOME}/antigravity-acp/settings.json`;
writeFileSync(set, JSON.stringify({ toolPermission: value }));
const agy = startNoted({ cwd, out: `${OUT5}/t7-${value}.jsonl` }, ["notes.txt", `<home>/antigravity-acp/settings.json = {toolPermission:${value}}`]);
try {
  const perms = handle(agy);
  const { sessionId } = await openSession(agy, { cwd });
  const r1 = await prompt(agy, sessionId, "Run the command: echo hi");
  const a = [...perms]; 
  const r2 = await prompt(agy, sessionId, "Append the line 'eggs' to notes.txt. Reply done.");
  console.log(value, "cmd:", r1.result?.stopReason, a, "edit:", r2.result?.stopReason, perms.slice(a.length), "tools:", toolNames(agy), "notes:", JSON.stringify(readFileSync(`${cwd}/notes.txt`, "utf8")));
} finally { await agy.close(); rmSync(set, { force: true }); cleanup(tmp); }
