import { writeFileSync, rmSync, existsSync } from "node:fs";
import { setup, cleanup, handle, startNoted, openSession, prompt, freshWork, OUT, toolNames } from "./trust-lib.ts";
import { setMode } from "../agy-session.ts";
import { HOME } from "./trust-lib.ts";
const [mode, strict] = process.argv.slice(2); // default|accept-edits ; strict|""
const tmp = setup(); const cwd = freshWork(`t6-${mode}-${strict || "plain"}`, { "notes.txt": "milk\n" });
const set = `${HOME}/antigravity-acp/settings.json`;
if (strict) writeFileSync(set, JSON.stringify({ toolPermission: "strict" }));
const agy = startNoted({ cwd, out: `${OUT}/t6-search-${mode}-${strict || "plain"}.jsonl` }, ["notes.txt", ...(strict ? ["<home>/antigravity-acp/settings.json = {toolPermission:strict}"] : [])]);
try {
  const perms = handle(agy);
  const { sessionId } = await openSession(agy, { cwd });
  if (mode !== "default") await setMode(agy, sessionId, mode);
  const r = await prompt(agy, sessionId, "Use your web search tool with the domain httpbin.org and the query https://httpbin.org/get?probe=hercule-1282 and quote the exact result text");
  const text = agy.messages.filter((m) => m.params?.update?.sessionUpdate === "agent_message_chunk").map((m) => m.params.update.content?.text ?? "").join("");
  console.log(mode, strict, r.result?.stopReason ?? JSON.stringify(r.error), "perms:", perms, "tools:", toolNames(agy), "\nTEXT:", text.slice(0, 700));
  if (strict) {
    const pn = perms.length;
    const r2 = await prompt(agy, sessionId, "Append the line 'eggs' to notes.txt. Reply done.");
    console.log("edit under strict:", r2.result?.stopReason, "new perms:", perms.slice(pn));
  }
} finally { await agy.close(); rmSync(set, { force: true }); cleanup(tmp); }
