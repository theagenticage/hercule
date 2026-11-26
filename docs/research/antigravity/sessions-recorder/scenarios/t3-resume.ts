import { existsSync, readFileSync } from "node:fs";
import { setup, cleanup, handle, startAgy, openSession, prompt, sleep, freshWork, HOME, OUT, modeUpdates, toolNames } from "./trust-lib.ts";
import { setMode } from "../agy-session.ts";
const tmp = setup(); const cwd = freshWork("t3", { "notes.txt": "milk\n" });
const out = `${OUT}/t3-resume.jsonl`;
const a = startAgy({ home: HOME, cwd, out });
let sid = "";
try {
  handle(a);
  const o = await openSession(a, { cwd }); sid = o.sessionId;
  console.log("A new modes:", JSON.stringify(o.session.result.modes));
  const s = await setMode(a, sid, "accept-edits"); console.log("A set_mode:", JSON.stringify(s.result ?? s.error), "updates:", modeUpdates(a));
  const r = await prompt(a, sid, "Reply OK."); console.log("A prompt", r.result?.stopReason);
} finally { await a.close(); }
const b = startAgy({ home: HOME, cwd, out, append: true });
try {
  b.note("process B resume");
  const perms = handle(b);
  const o = await openSession(b, { cwd, resumeId: sid });
  console.log("B resume reply:", JSON.stringify(o.session.result));
  await sleep(4000);
  console.log("B mode updates after 4s:", modeUpdates(b));
  const r = await prompt(b, sid, "Append the line 'eggs' to notes.txt (edit the file) and reply done.");
  console.log("B edit:", r.result?.stopReason, "perms:", perms, "file:", JSON.stringify(readFileSync(`${cwd}/notes.txt`, "utf8")), "tools:", toolNames(b));
  const n = b.messages.length;
  const same = await setMode(b, sid, "accept-edits");
  await sleep(1500);
  console.log("B set_mode same:", JSON.stringify(same.result ?? same.error), "updates:", modeUpdates(b));
  const d = await setMode(b, sid, "default"); await sleep(1000);
  console.log("B set_mode default:", JSON.stringify(d.result ?? d.error), "updates total:", modeUpdates(b));
} finally { await b.close(); cleanup(tmp); }
