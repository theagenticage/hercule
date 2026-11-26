import { readFileSync } from "node:fs";
import { setup, cleanup, handle, startNoted, openSession, prompt, sleep, freshWork, OUT, modeUpdates, toolNames } from "./trust-lib.ts";
import { setMode } from "../agy-session.ts";
const tmp = setup(); const cwd = freshWork("t4", { "notes.txt": "milk\n" });
const agy = startNoted({ cwd, out: `${OUT}/t4-plan.jsonl` }, ["notes.txt"]);
try {
  const perms = handle(agy);
  const { sessionId } = await openSession(agy, { cwd });
  let r = await prompt(agy, sessionId, "/plan");
  const txt = (from = 0) => agy.messages.slice(from).filter((m) => m.params?.update?.sessionUpdate === "agent_message_chunk").map((m) => m.params.update.content?.text ?? "").join("").slice(0, 300);
  console.log("/plan:", r.result?.stopReason ?? JSON.stringify(r.error), "perms:", perms, "updates:", modeUpdates(agy), "text:", JSON.stringify(txt()));
  await sleep(1500);
  const n = agy.messages.length, pn = perms.length;
  r = await prompt(agy, sessionId, "Append the line 'eggs' to notes.txt, then run `echo hi`. Reply done.");
  console.log("2nd:", r.result?.stopReason, "new perms:", perms.slice(pn), "tools:", toolNames(agy), "file:", JSON.stringify(readFileSync(`${cwd}/notes.txt`, "utf8")), "new mode updates:", modeUpdates(agy).length, "text:", JSON.stringify(txt(n)));
  const before = modeUpdates(agy).length;
  const d = await setMode(agy, sessionId, "default"); await sleep(1500);
  console.log("set_mode default after /plan:", JSON.stringify(d.result ?? d.error), "updates:", modeUpdates(agy).slice(before), "all:", modeUpdates(agy));
} finally { await agy.close(); cleanup(tmp); }
