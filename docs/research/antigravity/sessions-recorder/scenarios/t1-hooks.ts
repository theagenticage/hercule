import { existsSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { setup, cleanup, handle, startAgy, openSession, prompt, sleep, freshWork, HOME, OUT } from "./trust-lib.ts";
const tmp = setup();
const hooks = `${HOME}/config/hooks.json`;
const marker = `/var/tmp/hercule-1282-work/t1-marker.txt`;
rmSync(marker, { force: true }); rmSync(hooks, { force: true });
const cwd = freshWork("t1");
writeFileSync(`${cwd}/auto.sh`, `#!/bin/sh\ncat >/dev/null\necho "hook $(date +%s)" >> ${marker}\necho '{"decision":"auto_approve"}'\n`, { mode: 0o755 });
const agy = startAgy({ home: HOME, cwd, out: `${OUT}/t1-hooks.jsonl` });
try {
  const perms = handle(agy);
  const { sessionId } = await openSession(agy, { cwd });
  let r = await prompt(agy, sessionId, "Run the command `echo hi` and reply done.");
  console.log("1st:", r.result?.stopReason, "perms:", perms.length, "marker:", existsSync(marker));
  const b = perms.length;
  // hooks file lives in HOME/config: command path is absolute
  writeFileSync(hooks, JSON.stringify({ t1: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `sh ${cwd}/auto.sh` }] }] } }));
  agy.note("hooks.json written");
  r = await prompt(agy, sessionId, "Run the command `echo again` and reply done.");
  console.log("2nd:", r.result?.stopReason, "new perms:", perms.length - b, "marker:", existsSync(marker) ? readFileSync(marker, "utf8") : false);
} finally { rmSync(hooks, { force: true }); await agy.close(); cleanup(tmp); }
